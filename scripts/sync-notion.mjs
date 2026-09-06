#!/usr/bin/env node
/**
 * Exporte récursivement la base Politique Notion vers data.js.
 *
 * Variables requises :
 *   NOTION_TOKEN
 *   NOTION_ROOT_ID
 *
 * Structure gérée :
 *   Thème
 *     → Sous-thème
 *       → Catégorie
 *         → Fiche / Sujet
 *
 * Le script :
 *   - parcourt toute l'arborescence ;
 *   - ne dépend pas d'une profondeur fixe ;
 *   - met en cache les enfants déjà récupérés ;
 *   - ralentit les requêtes Notion pour limiter les 429 ;
 *   - refuse de produire un data.js partiel en cas d'échec API.
 */

import fs from "node:fs/promises";

const token = process.env.NOTION_TOKEN;
const rootId = process.env.NOTION_ROOT_ID?.replace(/-/g, "");

if (!token || !rootId) {
  console.error("NOTION_TOKEN et NOTION_ROOT_ID sont requis.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

/* =========================================================
   CONFIGURATION API
   ========================================================= */

const MAX_RETRIES = 6;

/*
 * On espace fortement les appels.
 * Le cache ci-dessous évite normalement beaucoup
 * de requêtes inutiles.
 */
const MIN_REQUEST_GAP_MS = 1200;

let lastRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRequestSlot() {
  const elapsed = Date.now() - lastRequestAt;

  if (elapsed < MIN_REQUEST_GAP_MS) {
    await sleep(MIN_REQUEST_GAP_MS - elapsed);
  }

  lastRequestAt = Date.now();
}

/* =========================================================
   CACHE
   ========================================================= */

const pageCache = new Map();
const childrenCache = new Map();

/* =========================================================
   APPEL NOTION
   ========================================================= */

async function notion(path) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForRequestSlot();

    let response;

    try {
      response = await fetch(
        `https://api.notion.com/v1${path}`,
        { headers }
      );
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Erreur réseau Notion sur ${path}: ${error.message}`
        );
      }

      const delayMs =
        Math.min(60000, 5000 * 2 ** attempt) +
        Math.floor(Math.random() * 3000);

      console.warn(
        `Erreur réseau sur ${path} — ` +
        `nouvelle tentative ${attempt + 1}/${MAX_RETRIES} ` +
        `dans ${Math.ceil(delayMs / 1000)}s.`
      );

      await sleep(delayMs);
      continue;
    }

    if (response.ok) {
      return response.json();
    }

    const body = await response.text();

    const retryAfterHeader =
      response.headers.get("retry-after");

    let retryAfterBody;

    try {
      retryAfterBody =
        JSON.parse(body)?.additional_data?.retry_after;
    } catch {
      retryAfterBody = undefined;
    }

    const isRateLimited =
      response.status === 429;

    const isServerError =
      response.status >= 500;

    if (
      (!isRateLimited && !isServerError) ||
      attempt === MAX_RETRIES
    ) {
      throw new Error(
        `Notion API ${response.status} ${path}: ` +
        `${body.slice(0, 1000)}`
      );
    }

    let delayMs;

    const retryAfterSeconds =
      Number(
        retryAfterHeader ??
        retryAfterBody ??
        0
      );

    if (isRateLimited) {
      /*
       * 429 :
       * on attend au minimum 30 secondes.
       * Le délai augmente progressivement.
       */
      delayMs = Math.min(
        180000,
        30000 * 2 ** attempt
      );
    } else {
      /*
       * 502 / 503 / 504...
       */
      delayMs = Math.min(
        60000,
        5000 * 2 ** attempt
      );
    }

    if (retryAfterSeconds > 0) {
      delayMs = Math.max(
        delayMs,
        retryAfterSeconds * 1000
      );
    }

    const jitterMs =
      Math.floor(Math.random() * 3000);

    const totalDelayMs =
      delayMs + jitterMs;

    console.warn(
      `Notion API ${response.status} sur ${path} — ` +
      `nouvelle tentative ${attempt + 1}/${MAX_RETRIES} ` +
      `dans ${Math.ceil(totalDelayMs / 1000)}s.`
    );

    await sleep(totalDelayMs);
  }

  throw new Error(
    `Nombre maximal de tentatives atteint pour ${path}`
  );
}

/* =========================================================
   PAGE
   ========================================================= */

async function getPage(pageId) {
  const id = pageId.replace(/-/g, "");

  if (pageCache.has(id)) {
    return pageCache.get(id);
  }

  const page = await notion(`/pages/${id}`);

  pageCache.set(id, page);

  return page;
}

/* =========================================================
   ENFANTS D'UNE PAGE / D'UN BLOC
   ========================================================= */

async function allChildren(blockId) {
  const id = blockId.replace(/-/g, "");

  if (childrenCache.has(id)) {
    return childrenCache.get(id);
  }

  const result = [];
  let cursor;

  do {
    const params = new URLSearchParams({
      page_size: "100"
    });

    if (cursor) {
      params.set("start_cursor", cursor);
    }

    const page = await notion(
      `/blocks/${id}/children?${params}`
    );

    result.push(...page.results);

    cursor =
      page.has_more
        ? page.next_cursor
        : undefined;

  } while (cursor);

  childrenCache.set(id, result);

  return result;
}

/* =========================================================
   HTML
   ========================================================= */

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function richText(items = []) {
  return items
    .map(item => {
      let text = escapeHtml(
        item.plain_text ??
        item.text?.content ??
        ""
      );

      if (item.annotations?.code) {
        text = `<code>${text}</code>`;
      } else if (item.annotations?.bold) {
        text = `<strong>${text}</strong>`;
      } else if (item.annotations?.italic) {
        text = `<em>${text}</em>`;
      }

      if (
        item.href &&
        /^(https?:|mailto:|#|\/)/i.test(item.href)
      ) {
        text =
          `<a href="${escapeAttr(item.href)}" ` +
          `target="_blank" ` +
          `rel="noopener noreferrer">` +
          `${text}</a>`;
      }

      return text;
    })
    .join("");
}

function blockToHtml(block) {
  const data =
    block[block.type] || {};

  const text =
    richText(data.rich_text);

  switch (block.type) {
    case "paragraph":
      return text
        ? `<p>${text}</p>`
        : "";

    case "heading_1":
      return `<h2>${text}</h2>`;

    case "heading_2":
      return `<h3>${text}</h3>`;

    case "heading_3":
      return `<h4>${text}</h4>`;

    case "quote":
      return `<blockquote>${text}</blockquote>`;

    case "callout":
      return (
        `<aside class="callout">${text}</aside>`
      );

    case "bulleted_list_item":
      return `<li>${text}</li>`;

    case "numbered_list_item":
      return `<li>${text}</li>`;

    case "to_do":
      return (
        `<p class="todo">` +
        `${data.checked ? "☑" : "☐"} ` +
        `${text}` +
        `</p>`
      );

    case "code": {
      const code =
        (data.rich_text || [])
          .map(x => x.plain_text || "")
          .join("");

      return (
        `<pre><code>` +
        `${escapeHtml(code)}` +
        `</code></pre>`
      );
    }

    case "divider":
      return "<hr>";

    case "bookmark":
      return data.url
        ? (
          `<p>` +
          `<a href="${escapeAttr(data.url)}" ` +
          `target="_blank" ` +
          `rel="noopener noreferrer">` +
          `${escapeHtml(data.url)}` +
          `</a>` +
          `</p>`
        )
        : "";

    case "image": {
      const url =
        data.type === "external"
          ? data.external?.url
          : data.file?.url;

      if (!url) {
        return "";
      }

      return (
        `<figure>` +
        `<img loading="lazy" ` +
        `src="${escapeAttr(url)}" ` +
        `alt="">` +
        (text
          ? `<figcaption>${text}</figcaption>`
          : "") +
        `</figure>`
      );
    }

    default:
      return text
        ? `<p>${text}</p>`
        : "";
  }
}

/* =========================================================
   RENDU DES BLOCS
   ========================================================= */

async function renderBlocks(blocks) {
  const output = [];

  let listType = null;
  let listItems = [];

  async function flushList() {
    if (!listItems.length) {
      return;
    }

    output.push(
      `<${listType}>` +
      `${listItems.join("")}` +
      `</${listType}>`
    );

    listItems = [];
    listType = null;
  }

  for (const block of blocks) {
    const currentListType =
      block.type === "bulleted_list_item"
        ? "ul"
        : block.type === "numbered_list_item"
          ? "ol"
          : null;

    if (currentListType) {
      if (
        listType &&
        listType !== currentListType
      ) {
        await flushList();
      }

      listType = currentListType;

      let html =
        blockToHtml(block);

      if (block.has_children) {
        const children =
          await allChildren(block.id);

        html +=
          await renderBlocks(children);
      }

      listItems.push(html);

      continue;
    }

    await flushList();

    let html =
      blockToHtml(block);

    if (block.has_children) {
      const children =
        await allChildren(block.id);

      html +=
        await renderBlocks(children);
    }

    output.push(html);
  }

  await flushList();

  return output
    .filter(Boolean)
    .join("\n");
}

/* =========================================================
   TITRES / STRUCTURE
   ========================================================= */

/*
 * Exemple :
 *   "🌍 10. Politique étrangère & Géopolitique"
 *
 * retourne :
 *   {
 *     num: 10,
 *     emoji: "🌍",
 *     title: "Politique étrangère & Géopolitique"
 *   }
 */
function parseThemeTitle(title = "") {
  const match =
    title.match(
      /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)?\s*(\d+)\.\s*(.+)$/u
    );

  if (!match) {
    return null;
  }

  return {
    num: Number(match[2]),
    emoji: match[1] || "",
    title: match[3].trim()
  };
}

/*
 * Exemple :
 *   "📂 10.1 Politique étrangère et diplomatie"
 *
 * retourne :
 *   "10.1"
 */
function extractCategoryCode(title = "") {
  const match =
    title.match(
      /\b(\d+\.\d+)\b/
    );

  return match?.[1] || "";
}

/*
 * Vérifie qu'un titre est une vraie page catégorie.
 */
function isCategoryTitle(title = "") {
  return /^\s*(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)?\s*\d+\.\d+\b/u.test(
    title
  );
}

/* =========================================================
   PARCOURS COMPLET DE L'ARBORESCENCE
   ========================================================= */

const records = [];
const visited = new Set();

async function collectPage({
  pageId,
  parentId = null,
  depth = 0,
  ancestry = []
}) {
  const id =
    pageId.replace(/-/g, "");

  if (visited.has(id)) {
    return;
  }

  visited.add(id);

  const page =
    await getPage(id);

  const titleProperty =
    Object.values(
      page.properties || {}
    ).find(
      property =>
        property.type === "title"
    );

  const title =
    titleProperty?.title
      ?.map(item => item.plain_text)
      .join("")
      .trim() ||
    "Sans titre";

  const blocks =
    await allChildren(id);

  const childPages =
    blocks.filter(
      block =>
        block.type === "child_page"
    );

  const record = {
    id,
    title,
    url:
      `https://www.notion.so/${id}`,
    parentId,
    depth,
    ancestry: [...ancestry],
    lastEditedTime:
      page.last_edited_time,
    html:
      await renderBlocks(blocks),
    childPageIds:
      childPages.map(
        block => block.id
      )
  };

  records.push(record);

  /*
   * On descend dans TOUTES les child_page,
   * quelle que soit leur profondeur.
   */
  for (const child of childPages) {
    await collectPage({
      pageId: child.id,
      parentId: id,
      depth: depth + 1,
      ancestry: [
        ...ancestry,
        id
      ]
    });
  }
}

/* =========================================================
   LANCEMENT DU PARCOURS
   ========================================================= */

console.log(
  "Début de la synchronisation Notion..."
);

await collectPage({
  pageId: rootId,
  parentId: null,
  depth: 0,
  ancestry: []
});

console.log(
  `Arborescence récupérée : ${records.length} pages.`
);

/* =========================================================
   RACINE
   ========================================================= */

const root =
  records.find(
    record =>
      record.id === rootId
  );

if (!root) {
  throw new Error(
    "La page racine Notion n'a pas été récupérée."
  );
}

/* =========================================================
   THÈMES
   ========================================================= */

/*
 * Les thèmes sont les pages directement sous la racine
 * ayant un titre du type :
 *
 *   1. Institutions...
 *   10. Politique étrangère...
 *   38. Politique du Handicap
 */
const themeRecords =
  records.filter(record => {
    if (record.parentId !== rootId) {
      return false;
    }

    return Boolean(
      parseThemeTitle(record.title)
    );
  });

console.log(
  `Thèmes détectés : ${themeRecords.length}.`
);

/* =========================================================
   INDEX DES THÈMES
   ========================================================= */

const themeById =
  new Map();

for (const record of themeRecords) {
  const parsed =
    parseThemeTitle(
      record.title
    );

  if (!parsed) {
    continue;
  }

  themeById.set(
    record.id,
    {
      record,
      num: parsed.num,
      emoji: parsed.emoji,
      titre: parsed.title
    }
  );
}

/* =========================================================
   CATÉGORIES
   ========================================================= */

/*
 * Une catégorie est reconnue grâce à son code :
 *
 *   10.1
 *   10.2
 *   20.1
 *   27.5
 *
 * On ne suppose PLUS qu'elle est depth === 2.
 */
const categoryById =
  new Map();

for (const record of records) {
  if (!isCategoryTitle(record.title)) {
    continue;
  }

  const code =
    extractCategoryCode(
      record.title
    );

  if (!code) {
    continue;
  }

  categoryById.set(
    record.id,
    {
      record,
      code
    }
  );
}

/* =========================================================
   TROUVER LE THÈME D'UNE PAGE
   ========================================================= */

function findThemeForRecord(record) {
  /*
   * On cherche d'abord dans les ancêtres.
   */
  for (
    let i = record.ancestry.length - 1;
    i >= 0;
    i--
  ) {
    const ancestorId =
      record.ancestry[i];

    if (themeById.has(ancestorId)) {
      return themeById.get(
        ancestorId
      );
    }
  }

  /*
   * Cas particulier : le parent direct est le thème.
   */
  if (
    record.parentId &&
    themeById.has(record.parentId)
  ) {
    return themeById.get(
      record.parentId
    );
  }

  return null;
}

/* =========================================================
   TROUVER LA CATÉGORIE D'UNE PAGE
   ========================================================= */

function findCategoryForRecord(record) {
  /*
   * On cherche la catégorie la plus proche
   * dans les ancêtres.
   */
  for (
    let i = record.ancestry.length - 1;
    i >= 0;
    i--
  ) {
    const ancestorId =
      record.ancestry[i];

    if (
      categoryById.has(
        ancestorId
      )
    ) {
      return categoryById.get(
        ancestorId
      );
    }
  }

  /*
   * Parent direct.
   */
  if (
    record.parentId &&
    categoryById.has(
      record.parentId
    )
  ) {
    return categoryById.get(
      record.parentId
    );
  }

  return null;
}

/* =========================================================
   CONSTRUCTION DES THÈMES
   ========================================================= */

const themes =
  themeRecords
    .map(record => {
      const parsed =
        parseThemeTitle(
          record.title
        );

      if (!parsed) {
        return null;
      }

      /*
       * On récupère toutes les catégories
       * qui appartiennent à ce thème,
       * même si elles sont à plusieurs niveaux.
       */
      const categories =
        records
          .filter(page => {
            const category =
              categoryById.get(
                page.id
              );

            if (!category) {
              return false;
            }

            const theme =
              findThemeForRecord(
                page
              );

            return (
              theme?.record.id ===
              record.id
            );
          })
          .map(page => {
            const category =
              categoryById.get(
                page.id
              );

            return {
              code:
                category.code,

              nom:
                page.title
                  .replace(
                    /^\s*(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)?\s*/u,
                    ""
                  )
                  .replace(
                    /^\d+\.\d+\s*/,
                    ""
                  )
                  .trim(),

              pageId:
                page.id
            };
          })
          .sort((a, b) =>
            a.code.localeCompare(
              b.code,
              "fr",
              {
                numeric: true
              }
            )
          );

      /*
       * Toutes les fiches rattachées
       * à ce thème.
       */
      const ficheCount =
        records.filter(page => {
          if (
            page.id ===
            record.id
          ) {
            return false;
          }

          const theme =
            findThemeForRecord(
              page
            );

          const category =
            findCategoryForRecord(
              page
            );

          /*
           * Une catégorie elle-même
           * n'est pas comptée comme fiche.
           */
          const isCategory =
            categoryById.has(
              page.id
            );

          return (
            theme?.record.id ===
              record.id &&
            category &&
            !isCategory
          );
        }).length;

      return {
        num:
          parsed.num,

        titre:
          parsed.title,

        emoji:
          parsed.emoji,

        notionId:
          record.id,

        pageId:
          record.id,

        statut:
          "Synchronisé depuis Notion",

        fiches:
          ficheCount,

        categories
      };
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.num - b.num
    );

/* =========================================================
   FICHES
   ========================================================= */

const fiches =
  records
    .filter(record => {
      /*
       * Une fiche doit être :
       *   - sous un thème ;
       *   - sous une catégorie ;
       *   - mais ne pas être elle-même une catégorie.
       */
      if (
        record.id === rootId
      ) {
        return false;
      }

      if (
        themeById.has(
          record.id
        )
      ) {
        return false;
      }

      if (
        categoryById.has(
          record.id
        )
      ) {
        return false;
      }

      const theme =
        findThemeForRecord(
          record
        );

      const category =
        findCategoryForRecord(
