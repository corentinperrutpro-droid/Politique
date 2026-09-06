import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

if (!NOTION_TOKEN) {
  throw new Error("NOTION_TOKEN manquant.");
}

if (!ROOT_PAGE_ID) {
  throw new Error("NOTION_ROOT_PAGE_ID manquant.");
}

const OUTPUT_FILE = "data.js";

// ============================================================
// Réglages anti-429
// ============================================================

const MAX_RETRIES = 5;
const MIN_REQUEST_GAP_MS = 1800;

let lastRequestAt = 0;

// ============================================================
// Cache
// ============================================================

const pageCache = new Map();
const childrenCache = new Map();

// File d'attente globale : UNE requête Notion à la fois.
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queueRequest(fn) {
  const run = requestQueue.then(fn, fn);

  requestQueue = run.catch(() => {});

  return run;
}

// ============================================================
// Appel Notion
// ============================================================

async function notion(path) {
  return queueRequest(async () => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const elapsed = Date.now() - lastRequestAt;

      if (elapsed < MIN_REQUEST_GAP_MS) {
        await sleep(MIN_REQUEST_GAP_MS - elapsed);
      }

      lastRequestAt = Date.now();

      const response = await fetch(`https://api.notion.com/v1${path}`, {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        }
      });

      if (response.ok) {
        return response.json();
      }

      const text = await response.text();

      const retryAfterHeader = response.headers.get("retry-after");

      if (response.status === 429) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Notion API 429 après ${MAX_RETRIES} tentatives sur ${path}`
          );
        }

        let waitMs;

        if (retryAfterHeader) {
          const retrySeconds = Number(retryAfterHeader);

          if (Number.isFinite(retrySeconds)) {
            waitMs = retrySeconds * 1000;
          }
        }

        if (!waitMs) {
          waitMs = Math.min(
            30000 * Math.pow(2, attempt),
            180000
          );
        }

        // Petit délai aléatoire pour éviter les collisions.
        waitMs += Math.floor(Math.random() * 5000);

        console.log(
          `Notion API 429 sur ${path} — nouvelle tentative ${
            attempt + 1
          }/${MAX_RETRIES} dans ${Math.round(waitMs / 1000)}s.`
        );

        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500 && response.status <= 599) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(
            `Notion API ${response.status} après ${MAX_RETRIES} tentatives sur ${path}: ${text}`
          );
        }

        const waitMs =
          Math.min(5000 * Math.pow(2, attempt), 60000) +
          Math.floor(Math.random() * 3000);

        console.log(
          `Notion API ${response.status} sur ${path} — nouvelle tentative ${
            attempt + 1
          }/${MAX_RETRIES} dans ${Math.round(waitMs / 1000)}s.`
        );

        await sleep(waitMs);
        continue;
      }

      throw new Error(
        `Notion API ${response.status} sur ${path}: ${text}`
      );
    }
  });
}

// ============================================================
// Utilitaires
// ============================================================

function richTextToPlain(richText = []) {
  return richText
    .map(item => item?.plain_text || "")
    .join("")
    .trim();
}

function getPageTitle(page) {
  const titleProperty = Object.values(page.properties || {}).find(
    property => property.type === "title"
  );

  return richTextToPlain(titleProperty?.title || "");
}

function getBlockText(block) {
  const value = block[block.type];

  if (!value) {
    return "";
  }

  return richTextToPlain(value.rich_text || []);
}

function cleanTitle(title) {
  return title
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================
// Pages
// ============================================================

async function getPage(pageId) {
  if (pageCache.has(pageId)) {
    return pageCache.get(pageId);
  }

  const page = await notion(`/pages/${pageId}`);

  pageCache.set(pageId, page);

  return page;
}

// ============================================================
// Enfants directs d'une page / d'un bloc
// ============================================================

async function getChildren(blockId) {
  if (childrenCache.has(blockId)) {
    return childrenCache.get(blockId);
  }

  const results = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({
      page_size: "100"
    });

    if (cursor) {
      params.set("start_cursor", cursor);
    }

    const data = await notion(
      `/blocks/${blockId}/children?${params.toString()}`
    );

    results.push(...(data.results || []));

    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  childrenCache.set(blockId, results);

  return results;
}

// ============================================================
// Arbre des pages
// ============================================================

async function collectPageTree(pageId, parentId = null, depth = 0, ancestry = []) {
  const page = await getPage(pageId);
  const title = cleanTitle(getPageTitle(page));

  const record = {
    id: page.id,
    title,
    parentId,
    depth,
    ancestry,
    page
  };

  const children = await getChildren(pageId);

  const childPages = children.filter(
    block => block.type === "child_page"
  );

  for (const child of childPages) {
    const childId = child.id;

    await collectPageTree(
      childId,
      pageId,
      depth + 1,
      [...ancestry, pageId]
    );
  }

  return record;
}

// ============================================================
// Collecte complète
// ============================================================

const records = [];

async function walkPages(pageId, parentId = null, depth = 0, ancestry = []) {
  const page = await getPage(pageId);

  const title = cleanTitle(getPageTitle(page));

  const record = {
    id: page.id,
    title,
    parentId,
    depth,
    ancestry
  };

  records.push(record);

  const children = await getChildren(pageId);

  for (const child of children) {
    if (child.type !== "child_page") {
      continue;
    }

    await walkPages(
      child.id,
      pageId,
      depth + 1,
      [...ancestry, pageId]
    );
  }
}

// ============================================================
// Détection thèmes / catégories
// ============================================================

function parseTheme(title) {
  const match = title.match(
    /(?:^|\s)(\d+)\.\s*(.+)$/u
  );

  if (!match) {
    return null;
  }

  const number = Number(match[1]);

  if (!Number.isInteger(number)) {
    return null;
  }

  return {
    number,
    title: match[2].trim()
  };
}

function parseCategory(title) {
  const match = title.match(
    /(?:^|\s)(\d+)\.(\d+)\s+(.+)$/u
  );

  if (!match) {
    return null;
  }

  return {
    themeNumber: Number(match[1]),
    categoryNumber: Number(match[2]),
    title: match[3].trim(),
    code: `${match[1]}.${match[2]}`
  };
}

// ============================================================
// Contenu des fiches
// ============================================================

function blockRichText(block) {
  const value = block[block.type];

  if (!value) {
    return "";
  }

  return richTextToPlain(value.rich_text || []);
}

async function renderBlocks(blocks) {
  const output = [];

  for (const block of blocks) {
    const type = block.type;

    if (
      type === "paragraph" ||
      type === "heading_1" ||
      type === "heading_2" ||
      type === "heading_3" ||
      type === "quote" ||
      type === "callout"
    ) {
      const text = blockRichText(block);

      if (text) {
        output.push(text);
      }

      // IMPORTANT :
      // On ne descend PAS automatiquement dans les blocs enfants.
      // C'est ce qui provoquait une avalanche de requêtes / 429.
      continue;
    }

    if (
      type === "bulleted_list_item" ||
      type === "numbered_list_item"
    ) {
      const text = blockRichText(block);

      if (text) {
        output.push(`• ${text}`);
      }

      continue;
    }

    if (type === "to_do") {
      const text = blockRichText(block);

      if (text) {
        const checked = block.to_do?.checked ? "☑" : "☐";
        output.push(`${checked} ${text}`);
      }

      continue;
    }

    if (type === "divider") {
      output.push("---");
      continue;
    }

    if (type === "code") {
      const text = block.code?.rich_text
        ? richTextToPlain(block.code.rich_text)
        : "";

      if (text) {
        output.push(text);
      }

      continue;
    }
  }

  return output.join("\n\n").trim();
}

async function getPageContent(pageId) {
  const blocks = await getChildren(pageId);

  return renderBlocks(blocks);
}

// ============================================================
// Construction des données
// ============================================================

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture de l'arborescence...");

await walkPages(ROOT_PAGE_ID);

console.log(`📄 Pages trouvées : ${records.length}`);

// ------------------------------------------------------------
// Thèmes
// ------------------------------------------------------------

const themes = records
  .map(record => {
    const parsed = parseTheme(record.title);

    if (!parsed) {
      return null;
    }

    return {
      ...record,
      ...parsed
    };
  })
  .filter(Boolean)
  .filter(theme => theme.id !== ROOT_PAGE_ID)
  .sort((a, b) => a.number - b.number);

console.log(`🏛️ Thèmes détectés : ${themes.length}`);

if (!themes.length) {
  throw new Error(
    "Aucun thème détecté. data.js ne sera PAS modifié."
  );
}

// ------------------------------------------------------------
// Catégories
// ------------------------------------------------------------

const categories = records
  .map(record => {
    const parsed = parseCategory(record.title);

    if (!parsed) {
      return null;
    }

    return {
      ...record,
      ...parsed
    };
  })
  .filter(Boolean);

console.log(`📂 Catégories détectées : ${categories.length}`);

// ------------------------------------------------------------
// Fiches
// ------------------------------------------------------------

const themeById = new Map(
  themes.map(theme => [theme.id, theme])
);

const categoryById = new Map(
  categories.map(category => [category.id, category])
);

const ficheRecords = records.filter(record => {
  // Une fiche doit appartenir à au moins un thème.
  const theme = record.ancestry
    .map(id => themeById.get(id))
    .find(Boolean);

  if (!theme) {
    return false;
  }

  // Les thèmes eux-mêmes ne sont pas des fiches.
  if (theme.id === record.id) {
    return false;
  }

  // Une catégorie n'est pas une fiche.
  if (categoryById.has(record.id)) {
    return false;
  }

  return true;
});

console.log(`📝 Fiches détectées : ${ficheRecords.length}`);

// ============================================================
// Génération
// ============================================================

const outputThemes = [];

for (const theme of themes) {
  console.log(
    `\n🏛️ Thème ${theme.number} — ${theme.title}`
  );

  const themeCategories = categories
    .filter(category => {
      if (
        category.themeNumber !== theme.number
      ) {
        return false;
      }

      return category.ancestry.includes(theme.id);
    })
    .sort(
      (a, b) =>
        a.categoryNumber - b.categoryNumber
    );

  console.log(
    `   📂 ${themeCategories.length} catégories`
  );

  const outputCategories = [];

  for (const category of themeCategories) {
    console.log(
      `   📁 ${category.code} — ${category.title}`
    );

    const fiches = ficheRecords
      .filter(fiche => {
        if (!fiche.ancestry.includes(category.id)) {
          return false;
        }

        return true;
      })
      .sort((a, b) =>
        a.title.localeCompare(
          b.title,
          "fr",
          { sensitivity: "base" }
        )
      );

    console.log(
      `      📝 ${fiches.length} fiches`
    );

    const outputFiches = [];

    for (const fiche of fiches) {
      console.log(
        `         → ${fiche.title}`
      );

      const content = await getPageContent(fiche.id);

      outputFiches.push({
        id: fiche.id,
        title: fiche.title,
        content
      });
    }

    outputCategories.push({
      code: category.code,
      title: category.title,
      fiches: outputFiches
    });
  }

  outputThemes.push({
    number: theme.number,
    title: theme.title,
    categories: outputCategories
  });
}

// ============================================================
// Index de recherche
// ============================================================

const ficheIndex = {};

for (const theme of outputThemes) {
  for (const category of theme.categories) {
    for (const fiche of category.fiches) {
      ficheIndex[fiche.id] = {
        ...fiche,
        themeNumber: theme.number,
        themeTitle: theme.title,
        categoryCode: category.code,
        categoryTitle: category.title
      };
    }
  }
}

// ============================================================
// Validation
// ============================================================

const totalCategories = outputThemes.reduce(
  (sum, theme) =>
    sum + theme.categories.length,
  0
);

const totalFiches = outputThemes.reduce(
  (sum, theme) =>
    sum +
    theme.categories.reduce(
      (catSum, category) =>
        catSum + category.fiches.length,
      0
    ),
  0
);

console.log("\n==============================");
console.log("📊 SYNCHRONISATION TERMINÉE");
console.log("==============================");
console.log(`🏛️ Thèmes     : ${outputThemes.length}`);
console.log(`📂 Catégories : ${totalCategories}`);
console.log(`📝 Fiches     : ${totalFiches}`);
console.log("==============================\n");

if (outputThemes.length < 5) {
  throw new Error(
    `Seulement ${outputThemes.length} thèmes exportés. data.js ne sera PAS modifié.`
  );
}

// ============================================================
// Écriture data.js
// ============================================================

const generated = `// Généré automatiquement depuis Notion.
// Ne pas modifier manuellement.

const DATA = ${JSON.stringify(
  {
    themes: outputThemes,
    ficheIndex
  },
  null,
  2
)};
`;

await fs.writeFile(
  OUTPUT_FILE,
  generated,
  "utf8"
);

console.log(
  `✅ ${OUTPUT_FILE} généré avec succès.`
);
