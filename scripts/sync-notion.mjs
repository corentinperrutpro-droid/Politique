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
const childrenCache = new Map();
const pageCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function queueRequest(fn) {
  const run = requestQueue.then(fn, fn);
  requestQueue = run.catch(() => {});
  return run;
}

async function notion(path) {
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
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json"
          },
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Erreur réseau Notion après ${MAX_RETRIES} tentatives sur ${path}: ${error?.message || error}`);
        }
        const waitMs = Math.min(2000 * 2 ** attempt, 30000);
        console.log(`Erreur réseau Notion sur ${path} — nouvelle tentative dans ${Math.round(waitMs / 1000)}s.`);
        await sleep(waitMs);
        continue;
      }

      clearTimeout(timeout);

      if (response.ok) return response.json();

      const text = await response.text();
      const retryAfter = Number(response.headers.get("retry-after"));

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new Error(`Notion API ${response.status} après ${MAX_RETRIES} tentatives sur ${path}: ${text}`);
        }
        const base = response.status === 429 ? 30000 : 5000;
        const cap = response.status === 429 ? 180000 : 60000;
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(base * 2 ** attempt, cap);
        console.log(`Notion API ${response.status} sur ${path} — nouvelle tentative dans ${Math.round(waitMs / 1000)}s.`);
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Notion API ${response.status} sur ${path}: ${text}`);
    }
  });
}

async function getPage(pageId) {
  if (!pageCache.has(pageId)) pageCache.set(pageId, notion(`/pages/${pageId}`));
  return pageCache.get(pageId);
}

async function getChildren(blockId) {
  if (childrenCache.has(blockId)) return childrenCache.get(blockId);

  const promise = (async () => {
    const results = [];
    let cursor = null;

    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);
      const data = await notion(`/blocks/${blockId}/children?${params}`);
      results.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);

    return results;
  })();

  childrenCache.set(blockId, promise);
  return promise;
}

function richTextToPlain(richText = []) {
  return richText.map(item => item?.plain_text || "").join("").trim();
}

function getPageTitle(page) {
  const property = Object.values(page.properties || {}).find(p => p.type === "title");
  return richTextToPlain(property?.title || "");
}

function childPageTitle(block) {
  return block.child_page?.title || "";
}

function cleanTitle(title) {
  return title.replace(/\s+/g, " ").trim();
}

function parseTheme(title) {
  const match = title.match(/^\s*(\d+)\.\s+(.+)$/u);
  return match ? { number: Number(match[1]), title: match[2].trim() } : null;
}

function parseCategory(title) {
  const match = title.match(/^\s*(\d+)\.(\d+)\.?\s+(.+)$/u);
  if (!match) return null;
  return {
    themeNumber: Number(match[1]),
    categoryNumber: Number(match[2]),
    title: match[3].trim(),
    code: `${match[1]}.${match[2]}`
  };
}

async function collectTree() {
  const records = [];
  const visited = new Set();
  const root = await getPage(ROOT_PAGE_ID);

  async function walk(pageId, title, parentId, ancestry, depth) {
    if (visited.has(pageId)) return;
    visited.add(pageId);

    records.push({
      id: pageId,
      title: cleanTitle(title),
      parentId,
      ancestry,
      depth
    });

    const children = await getChildren(pageId);
    const childPages = children.filter(block => block.type === "child_page");

    for (const child of childPages) {
      await walk(
        child.id,
        childPageTitle(child),
        pageId,
        [...ancestry, pageId],
        depth + 1
      );
    }

    if (records.length % 100 === 0) {
      console.log(`   ↳ ${records.length} pages parcourues...`);
    }
  }

  await walk(ROOT_PAGE_ID, getPageTitle(root), null, [], 0);
  return records;
}

function blockRichText(block) {
  const value = block[block.type];
  return value ? richTextToPlain(value.rich_text || []) : "";
}

function renderBlocks(blocks) {
  const output = [];

  for (const block of blocks) {
    const type = block.type;
    const text = blockRichText(block);

    if (["paragraph", "heading_1", "heading_2", "heading_3", "quote", "callout"].includes(type)) {
      if (text) output.push(text);
    } else if (type === "bulleted_list_item" || type === "numbered_list_item") {
      if (text) output.push(`• ${text}`);
    } else if (type === "to_do") {
      if (text) output.push(`${block.to_do?.checked ? "☑" : "☐"} ${text}`);
    } else if (type === "divider") {
      output.push("---");
    } else if (type === "code" && text) {
      output.push(text);
    }
  }

  return output.join("\n\n").trim();
}

async function getPageContent(pageId) {
  return renderBlocks(await getChildren(pageId));
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture de l'arborescence réelle depuis la page racine...");

const records = await collectTree();
console.log(`📄 Pages trouvées : ${records.length}`);

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
if (!categories.length) throw new Error("Aucune catégorie détectée. data.js ne sera PAS modifié.");

const categoryIds = new Set(categories.map(category => category.id));
const ficheRecords = records.filter(record =>
  !categoryIds.has(record.id) && record.ancestry.some(id => categoryIds.has(id))
);

console.log(`📝 Fiches détectées : ${ficheRecords.length}`);
if (!ficheRecords.length) throw new Error("Aucune fiche détectée. data.js ne sera PAS modifié.");

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
    fiches: themeCategories.reduce(
      (count, category) => count + ficheRecords.filter(fiche => fiche.ancestry.includes(category.id)).length,
      0
    ),
    categories: outputCategories
  });
}

if (!outputFiches.length) throw new Error("Aucune fiche avec contenu détectée. data.js ne sera PAS remplacé.");

const emptyContent = outputFiches.filter(fiche => !fiche.html).length;
console.log(`📦 Fiches avec contenu : ${outputFiches.length - emptyContent}/${outputFiches.length}`);
if (emptyContent > 0) console.log(`⚠️ ${emptyContent} fiches ont un contenu top-level vide.`);

const output = `// Données générées depuis Notion — ne pas modifier manuellement.\nconst SITE_DATA = ${JSON.stringify({ themes: outputThemes, fiches: outputFiches }, null, 2)};\n`;
await fs.writeFile(OUTPUT_FILE, output, "utf8");
console.log(`\n✅ ${OUTPUT_FILE} généré avec succès : ${outputFiches.length} fiches.`);
