import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN manquant.");
if (!ROOT_PAGE_ID) throw new Error("NOTION_ROOT_PAGE_ID manquant.");

const OUTPUT_FILE = "data.js";
const MAX_RETRIES = 5;
const MIN_REQUEST_GAP_MS = 300;
const REQUEST_TIMEOUT_MS = 30000;
let lastRequestAt = 0;

const pageCache = new Map();
const childrenCache = new Map();
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queueRequest(fn) {
  const run = requestQueue.then(fn, fn);
  requestQueue = run.catch(() => {});
  return run;
}

async function notion(path, { method = "GET", body = undefined } = {}) {
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
          method,
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          body: body === undefined ? undefined : JSON.stringify(body),
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
        waitMs += Math.floor(Math.random() * 5000);
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

async function getPage(pageId) {
  if (pageCache.has(pageId)) return pageCache.get(pageId);
  const page = await notion(`/pages/${pageId}`);
  pageCache.set(pageId, page);
  return page;
}

async function getChildren(blockId) {
  if (childrenCache.has(blockId)) return childrenCache.get(blockId);

  const results = [];
  let cursor = null;

  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const data = await notion(`/blocks/${blockId}/children?${params.toString()}`);
    results.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  childrenCache.set(blockId, results);
  return results;
}

// ============================================================
// Arborescence : une seule requête Search par tranche de 100 pages
// au lieu d'une requête /blocks/:id/children pour chaque page.
// ============================================================

async function searchAllPages() {
  const pages = [];
  let cursor = null;

  do {
    const body = { page_size: 100, filter: { property: "object", value: "page" } };
    if (cursor) body.start_cursor = cursor;

    const data = await notion("/search", { method: "POST", body });
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;

    console.log(`   ↳ ${pages.length} pages Notion indexées...`);
  } while (cursor);

  return pages;
}

async function collectPageTree() {
  const pages = await searchAllPages();
  const byParent = new Map();

  for (const page of pages) {
    const parentId = page.parent?.type === "page_id" ? page.parent.page_id : null;
    if (!parentId) continue;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(page);
  }

  const records = [];
  const visited = new Set();

  function walk(page, parentId, depth, ancestry) {
    if (!page || visited.has(page.id)) return;
    visited.add(page.id);

    const record = {
      id: page.id,
      title: cleanTitle(getPageTitle(page)),
      parentId,
      depth,
      ancestry
    };
    records.push(record);

    const children = byParent.get(page.id) || [];
    for (const child of children) {
      walk(child, page.id, depth + 1, [...ancestry, page.id]);
    }
  }

  const root = pages.find(page => page.id === ROOT_PAGE_ID);

  if (!root) {
    // Le root peut être absent du Search selon le partage Notion.
    const rootPage = await getPage(ROOT_PAGE_ID);
    walk(rootPage, null, 0, []);
  } else {
    walk(root, null, 0, []);
  }

  return records;
}

function parseTheme(title) {
  const match = title.match(/(?:^|\s)(\d+)\.\s*(.+)$/u);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isInteger(number)) return null;
  return { number, title: match[2].trim() };
}

function parseCategory(title) {
  const match = title.match(/(?:^|\s)(\d+)\.(\d+)\s+(.+)$/u);
  if (!match) return null;
  return {
    themeNumber: Number(match[1]),
    categoryNumber: Number(match[2]),
    title: match[3].trim(),
    code: `${match[1]}.${match[2]}`
  };
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

    if (["paragraph", "heading_1", "heading_2", "heading_3", "quote", "callout"].includes(type)) {
      const text = blockRichText(block);
      if (text) output.push(text);
      continue;
    }

    if (type === "bulleted_list_item" || type === "numbered_list_item") {
      const text = blockRichText(block);
      if (text) output.push(`• ${text}`);
      continue;
    }

    if (type === "to_do") {
      const text = blockRichText(block);
      if (text) output.push(`${block.to_do?.checked ? "☑" : "☐"} ${text}`);
      continue;
    }

    if (type === "divider") {
      output.push("---");
      continue;
    }

    if (type === "code") {
      const text = richTextToPlain(block.code?.rich_text || []);
      if (text) output.push(text);
    }
  }

  return output.join("\n\n").trim();
}

async function getPageContent(pageId) {
  return renderBlocks(await getChildren(pageId));
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture de l'arborescence via l'index Notion...");

const records = await collectPageTree();
console.log(`📄 Pages trouvées : ${records.length}`);

const themes = records
  .map(record => {
    const parsed = parseTheme(record.title);
    return parsed ? { ...record, ...parsed } : null;
  })
  .filter(Boolean)
  .filter(theme => theme.id !== ROOT_PAGE_ID)
  .sort((a, b) => a.number - b.number);

console.log(`🏛️ Thèmes détectés : ${themes.length}`);
if (!themes.length) throw new Error("Aucun thème détecté. data.js ne sera PAS modifié.");

const categories = records
  .map(record => {
    const parsed = parseCategory(record.title);
    return parsed ? { ...record, ...parsed } : null;
  })
  .filter(Boolean);

console.log(`📂 Catégories détectées : ${categories.length}`);

const themeById = new Map(themes.map(theme => [theme.id, theme]));
const categoryById = new Map(categories.map(category => [category.id, category]));

const ficheRecords = records.filter(record => {
  const theme = record.ancestry.map(id => themeById.get(id)).find(Boolean);
  if (!theme || theme.id === record.id) return false;
  return !categoryById.has(record.id);
});

console.log(`📝 Fiches détectées : ${ficheRecords.length}`);

const outputThemes = [];

for (const theme of themes) {
  console.log(`\n🏛️ Thème ${theme.number} — ${theme.title}`);

  const themeCategories = categories
    .filter(category => category.themeNumber === theme.number && category.ancestry.includes(theme.id))
    .sort((a, b) => a.categoryNumber - b.categoryNumber);

  console.log(`   📂 ${themeCategories.length} catégories`);
  const outputCategories = [];

  for (const category of themeCategories) {
    console.log(`   📁 ${category.code} — ${category.title}`);

    const fiches = ficheRecords
      .filter(fiche => fiche.ancestry.includes(category.id))
      .sort((a, b) => a.title.localeCompare(b.title, "fr", { sensitivity: "base" }));

    console.log(`      📝 ${fiches.length} fiches`);
    const outputFiches = [];

    for (const fiche of fiches) {
      console.log(`         → ${fiche.title}`);
      outputFiches.push({ id: fiche.id, title: fiche.title, content: await getPageContent(fiche.id) });
    }

    outputCategories.push({ code: category.code, title: category.title, fiches: outputFiches });
  }

  outputThemes.push({ number: theme.number, title: theme.title, categories: outputCategories });
}

const output = `window.POLITIQUE_DATA = ${JSON.stringify({ themes: outputThemes }, null, 2)};\n`;
await fs.writeFile(OUTPUT_FILE, output, "utf8");
console.log(`\n✅ ${OUTPUT_FILE} généré avec succès.`);
