import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN manquant.");
if (!ROOT_PAGE_ID) throw new Error("NOTION_ROOT_PAGE_ID manquant.");

const OUTPUT_FILE = "data.js";
const MAX_RETRIES = 5;
const MIN_REQUEST_GAP_MS = 350;
const REQUEST_TIMEOUT_MS = 30000;
let lastRequestAt = 0;
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queueRequest(fn) {
  const run = requestQueue.then(fn, fn);
  requestQueue = run.catch(() => {});
  return run;
}

async function notion(path, options = {}) {
  return queueRequest(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const elapsed = Date.now() - lastRequestAt;
      if (elapsed < MIN_REQUEST_GAP_MS) await sleep(MIN_REQUEST_GAP_MS - elapsed);
      lastRequestAt = Date.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;

      try {
        response = await fetch(`https://api.notion.com/v1${path}`, {
          method: options.method || "GET",
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Erreur réseau Notion après ${MAX_RETRIES} tentatives sur ${path}: ${error?.message || error}`);
        }
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 30000);
        console.log(`Erreur réseau Notion sur ${path} — nouvelle tentative ${attempt + 1}/${MAX_RETRIES} dans ${Math.round(waitMs / 1000)}s.`);
        await sleep(waitMs);
        continue;
      }

      clearTimeout(timeout);

      if (response.ok) return response.json();

      const text = await response.text();
      const retryAfterHeader = response.headers.get("retry-after");

      if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Notion API ${response.status} après ${MAX_RETRIES} tentatives sur ${path}: ${text}`);
        }

        let waitMs;
        if (response.status === 429 && retryAfterHeader) {
          const retrySeconds = Number(retryAfterHeader);
          if (Number.isFinite(retrySeconds)) waitMs = retrySeconds * 1000;
        }
        if (!waitMs) {
          const base = response.status === 429 ? 30000 : 5000;
          const cap = response.status === 429 ? 180000 : 60000;
          waitMs = Math.min(base * Math.pow(2, attempt), cap);
        }
        waitMs += Math.floor(Math.random() * 3000);
        console.log(`Notion API ${response.status} sur ${path} — nouvelle tentative ${attempt + 1}/${MAX_RETRIES} dans ${Math.round(waitMs / 1000)}s.`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Notion API ${response.status} sur ${path}: ${text}`);
    }
  });
}

function richTextToPlain(richText = []) {
  return richText.map(item => item?.plain_text || "").join("").trim();
}

function getPageTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find(property => property.type === "title");
  return richTextToPlain(titleProperty?.title || "");
}

function cleanTitle(title) {
  return title.replace(/\s+/g, " ").trim();
}

function parseTheme(title) {
  const match = title.match(/^\s*(\d+)\.\s+(.+)$/u);
  if (!match) return null;
  return { number: Number(match[1]), title: match[2].trim() };
}

function parseCategory(title) {
  // Accepte « 1.1 Titre », « 1.1. Titre » et les variantes d'espacement.
  const match = title.match(/^\s*(\d+)\.(\d+)\.?\s+(.+)$/u);
  if (!match) return null;
  return {
    themeNumber: Number(match[1]),
    categoryNumber: Number(match[2]),
    title: match[3].trim(),
    code: `${match[1]}.${match[2]}`
  };
}

async function searchAllPages() {
  const pages = [];
  let cursor = null;

  do {
    const body = { page_size: 100, sort: { direction: "ascending", timestamp: "last_edited_time" } };
    if (cursor) body.start_cursor = cursor;

    const data = await notion("/search", { method: "POST", body });
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;

    console.log(`   ↳ ${pages.length} pages Notion indexées...`);
  } while (cursor);

  return pages;
}

function buildRecords(pages) {
  const byId = new Map(pages.map(page => [page.id, page]));
  const parentOf = new Map();

  for (const page of pages) {
    const parent = page.parent || {};
    if (parent.type === "page_id" && parent.page_id) parentOf.set(page.id, parent.page_id);
    else if (parent.type === "block_id" && parent.block_id) parentOf.set(page.id, parent.block_id);
  }

  function ancestryFor(id) {
    const ancestry = [];
    const seen = new Set();
    let current = parentOf.get(id) || null;

    while (current && !seen.has(current)) {
      seen.add(current);
      ancestry.unshift(current);
      current = parentOf.get(current) || null;
    }
    return ancestry;
  }

  return pages.map(page => ({
    id: page.id,
    title: cleanTitle(getPageTitle(page)),
    parentId: parentOf.get(page.id) || null,
    ancestry: ancestryFor(page.id),
    page
  }));
}

async function getChildren(blockId) {
  const results = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const data = await notion(`/blocks/${blockId}/children?${params.toString()}`);
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  return results;
}

function blockRichText(block) {
  const value = block[block.type];
  if (!value) return "";
  return richTextToPlain(value.rich_text || []);
}

function renderBlocks(blocks) {
  const output = [];

  for (const block of blocks) {
    const type = block.type;
    const text = blockRichText(block);

    if (["paragraph", "heading_1", "heading_2", "heading_3", "quote", "callout"].includes(type)) {
      if (text) output.push(text);
      continue;
    }

    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      if (text) output.push(`• ${text}`);
      continue;
    }

    if (type === "to_do") {
      if (text) output.push(`${block.to_do?.checked ? "☑" : "☐"} ${text}`);
      continue;
    }

    if (type === "divider") {
      output.push("---");
      continue;
    }

    if (type === "code" && text) output.push(text);
  }

  return output.join("\n\n").trim();
}

async function getPageContent(pageId) {
  return renderBlocks(await getChildren(pageId));
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture de l'arborescence via l'index Notion...");

const pages = await searchAllPages();
const records = buildRecords(pages);
console.log(`📄 Pages trouvées : ${records.length}`);

// La hiérarchie est déterminée par le parent Notion, pas seulement par le titre.
// Ainsi une fiche « 1. ... » située sous une catégorie ne devient jamais un thème.
const themes = records
  .filter(record => record.parentId === ROOT_PAGE_ID)
  .map(record => {
    const parsed = parseTheme(record.title);
    return parsed ? { ...record, ...parsed } : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));

console.log(`🏛️ Thèmes détectés : ${themes.length}`);
if (!themes.length) throw new Error("Aucun thème détecté. data.js ne sera PAS modifié.");

const themeById = new Map(themes.map(theme => [theme.id, theme]));

const categories = records
  .filter(record => themeById.has(record.parentId))
  .map(record => {
    const parsed = parseCategory(record.title);
    return parsed ? { ...record, ...parsed } : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.themeNumber - b.themeNumber || a.categoryNumber - b.categoryNumber || a.id.localeCompare(b.id));

console.log(`📂 Catégories détectées : ${categories.length}`);

const categoryById = new Map(categories.map(category => [category.id, category]));
const categoryIds = new Set(categories.map(category => category.id));

// Une fiche est un descendant d'une catégorie, mais n'est pas elle-même une catégorie.
const ficheRecords = records.filter(record => {
  if (categoryIds.has(record.id)) return false;
  return record.ancestry.some(id => categoryById.has(id));
});

console.log(`📝 Fiches détectées : ${ficheRecords.length}`);

const outputThemes = [];
const outputFiches = [];

for (const theme of themes) {
  console.log(`\n🏛️ Thème ${theme.number} — ${theme.title}`);

  const themeCategories = categories
    .filter(category => category.parentId === theme.id)
    .sort((a, b) => a.categoryNumber - b.categoryNumber || a.id.localeCompare(b.id));

  console.log(`   📂 ${themeCategories.length} catégories`);
  const outputCategories = [];

  for (const category of themeCategories) {
    console.log(`   📁 ${category.code} — ${category.title}`);

    const fiches = ficheRecords
      .filter(fiche => fiche.ancestry.includes(category.id))
      .sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));

    console.log(`      📝 ${fiches.length} fiches`);
    outputCategories.push({ code: category.code, nom: category.title });

    for (const fiche of fiches) {
      console.log(`         → ${fiche.title}`);
      const html = await getPageContent(fiche.id);
      outputFiches.push({
        id: fiche.id,
        titre: fiche.title,
        cat: category.code,
        theme: theme.number,
        html
      });
    }
  }

  outputThemes.push({
    num: theme.number,
    titre: theme.title,
    emoji: "",
    notionId: theme.id,
    statut: "",
    fiches: themeCategories.reduce((count, category) => count + ficheRecords.filter(fiche => fiche.ancestry.includes(category.id)).length, 0),
    categories: outputCategories
  });
}

if (!outputFiches.length) {
  throw new Error("Aucune fiche avec contenu détectée. data.js ne sera PAS remplacé.");
}

const emptyContent = outputFiches.filter(fiche => !fiche.html).length;
if (emptyContent > 0) {
  console.log(`⚠️ ${emptyContent} fiches n'ont pas de texte top-level dans Notion.`);
}

const output = `// Données générées depuis Notion — ne pas modifier manuellement.\nconst SITE_DATA = ${JSON.stringify({ themes: outputThemes, fiches: outputFiches }, null, 2)};\n`;
await fs.writeFile(OUTPUT_FILE, output, "utf8");
console.log(`\n✅ ${OUTPUT_FILE} généré avec succès : ${outputFiches.length} fiches.`);