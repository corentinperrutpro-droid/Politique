import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONFIGURED_ROOT_ID = process.env.NOTION_ROOT_PAGE_ID;
const OUTPUT_FILE = "data.js";
const TEMP_FILE = "data.js.tmp";
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_GAP_MS = 350;
const MAX_DEPTH = 50;
const ROOT_TITLE = "🏛️ DOCUMENTATION POLITIQUE — Base de Décision d'État";

if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN manquant.");
if (!CONFIGURED_ROOT_ID) throw new Error("NOTION_ROOT_PAGE_ID manquant.");

let nextRequestAt = 0;
const childrenCache = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForRequestSlot() {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + MIN_REQUEST_GAP_MS;
  if (startAt > now) await sleep(startAt - now);
}

async function notion(path, options = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.notion.com/v1${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) return response.json();
      const body = await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`Notion API ${response.status} sur ${path}: ${body}`);
      if (attempt >= MAX_RETRIES) throw new Error(`Notion API ${response.status} après ${MAX_RETRIES} tentatives sur ${path}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min((response.status === 429 ? 5000 : 3000) * 2 ** attempt, 60000);
      console.log(`⚠️ Notion API ${response.status} sur ${path} — nouvelle tentative dans ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
    } catch (error) {
      clearTimeout(timeout);
      if (error?.message?.startsWith("Notion API ")) throw error;
      if (attempt >= MAX_RETRIES) throw new Error(`Erreur réseau Notion après ${MAX_RETRIES} tentatives sur ${path}: ${error?.message || error}`);
      const waitMs = Math.min(2000 * 2 ** attempt, 30000);
      console.log(`⚠️ Réseau Notion sur ${path} — nouvelle tentative dans ${Math.ceil(waitMs / 1000)}s.`);
      await sleep(waitMs);
    }
  }
}

function cleanTitle(title = "") { return title.replace(/\s+/g, " ").trim(); }
function richTextToPlain(richText = []) { return richText.map(item => item?.plain_text || "").join("").trim(); }
function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function normalizeId(id) { return String(id || "").replace(/-/g, "").toLowerCase(); }
function sameId(a, b) { return normalizeId(a) === normalizeId(b); }
function normalizeTitleForExclusion(title = "") {
  return cleanTitle(title).replace(/^[^\p{L}\p{N}]+/u, "").toLocaleLowerCase("fr-FR");
}
function isExcludedPublicPage(title = "") {
  const normalized = normalizeTitleForExclusion(title);
  return /^(?:registres?|audit)\b/u.test(normalized);
}
function isPublicSpecialTheme(title = "") {
  const normalized = normalizeTitleForExclusion(title);
  return normalized.startsWith("rassemblement national — dossier programmatique");
}

async function getPageTitle(pageId) {
  const data = await notion(`/pages/${pageId}`);
  const property = Object.values(data.properties || {}).find(p => p.type === "title");
  return cleanTitle(richTextToPlain(property?.title || []));
}

async function findCanonicalRoot() {
  try {
    const configuredTitle = await getPageTitle(CONFIGURED_ROOT_ID);
    if (configuredTitle === ROOT_TITLE) {
      console.log(`🏠 Racine configurée validée : ${CONFIGURED_ROOT_ID}`);
      return { id: CONFIGURED_ROOT_ID, title: configuredTitle };
    }
    console.log(`⚠️ Racine configurée = « ${configuredTitle || "sans titre" } ». Recherche de la racine canonique...`);
  } catch (error) {
    console.log(`⚠️ Racine configurée inaccessible (${error.message}). Recherche de la racine canonique...`);
  }

  const data = await notion("/search", {
    method: "POST",
    body: JSON.stringify({ query: "DOCUMENTATION POLITIQUE", page_size: 100, filter: { property: "object", value: "page" } })
  });
  const match = (data.results || []).find(page => {
    const property = Object.values(page.properties || {}).find(p => p.type === "title");
    return cleanTitle(richTextToPlain(property?.title || [])) === ROOT_TITLE;
  });
  if (!match) throw new Error(`Impossible de trouver la page racine canonique « ${ROOT_TITLE} ».`);
  console.log(`🏠 Racine canonique trouvée : ${match.id}`);
  return { id: match.id, title: ROOT_TITLE };
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

function childPageTitle(block) { return cleanTitle(block.child_page?.title || ""); }
function parseNumberedTitle(title) {
  const match = cleanTitle(title).match(/^(?:[^\d\n]*?)(\d+(?:\.\d+)*)\.?\s+(.+)$/u);
  return match ? { code: match[1], title: match[2].trim() } : null;
}
function blockRichText(block) {
  const value = block[block.type];
  return richTextToPlain(value?.rich_text || []);
}

function blockToHtml(block, text) {
  const safe = escapeHtml(text);
  switch (block.type) {
    case "paragraph": return text ? `<p>${safe}</p>` : "";
    case "heading_1": return text ? `<h2>${safe}</h2>` : "";
    case "heading_2": return text ? `<h3>${safe}</h3>` : "";
    case "heading_3": return text ? `<h4>${safe}</h4>` : "";
    case "quote": return text ? `<blockquote>${safe}</blockquote>` : "";
    case "callout": return text ? `<blockquote>${safe}</blockquote>` : "";
    case "bulleted_list_item": return text ? `<ul><li>${safe}</li></ul>` : "";
    case "numbered_list_item": return text ? `<ol><li>${safe}</li></ol>` : "";
    case "to_do": return text ? `<p>☐ ${safe}</p>` : "";
    case "divider": return "<hr>";
    case "code": return text ? `<pre><code>${safe}</code></pre>` : "";
    default: return "";
  }
}

async function renderBlocks(blocks) {
  const output = [];
  for (const block of blocks) {
    const text = blockRichText(block);
    const rendered = blockToHtml(block, text);
    if (rendered) output.push(rendered);
    if (block.has_children) {
      const nested = await renderBlocks(await getChildren(block.id));
      if (nested) output.push(nested);
    }
  }
  return output.join("\n").trim();
}

async function buildNode(pageId, title, parentId, depth, path) {
  if (isExcludedPublicPage(title)) return null;
  if (depth > MAX_DEPTH) throw new Error(`Profondeur maximale dépassée (${MAX_DEPTH}) sur ${pageId}.`);
  const blocks = await getChildren(pageId);
  const childPages = blocks
    .filter(block => block.type === "child_page" && childPageTitle(block))
    .filter(block => !isExcludedPublicPage(childPageTitle(block)));
  const node = { id: pageId, title: cleanTitle(title), parentId, depth, path: [...path, cleanTitle(title)], children: [] };
  if (!childPages.length) {
    node.type = "fiche";
    node.content = await renderBlocks(blocks);
    return node;
  }
  node.type = "folder";
  const children = await Promise.all(childPages.map(child => buildNode(child.id, childPageTitle(child), pageId, depth + 1, node.path)));
  node.children = children.filter(Boolean);
  return node;
}

function sortTree(node) {
  node.children.sort((a, b) => {
    const pa = parseNumberedTitle(a.title), pb = parseNumberedTitle(b.title);
    if (pa && pb) return pa.code.localeCompare(pb.code, "fr", { numeric: true });
    if (pa) return -1;
    if (pb) return 1;
    return a.title.localeCompare(b.title, "fr");
  });
  node.children.forEach(sortTree);
}

function flattenFiches(node, ancestors = [], result = []) {
  const current = [...ancestors, node];
  if (node.type === "fiche") {
    const theme = current.find(item => item.depth === 1);
    const nearestNumbered = [...current].reverse().find(item => parseNumberedTitle(item.title));
    result.push({ id: node.id, titre: node.title, html: node.content || "", path: node.path, theme: theme ? parseNumberedTitle(theme.title)?.code || null : null, cat: nearestNumbered ? parseNumberedTitle(nearestNumbered.title)?.code || "" : "" });
    return result;
  }
  for (const child of node.children) flattenFiches(child, current, result);
  return result;
}

function countNodes(node) { return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0); }
function maxDepth(node) { return Math.max(node.depth, ...node.children.map(maxDepth)); }

function assertTree(root, themes, fiches) {
  if (!themes.length) throw new Error("Aucun thème détecté. data.js ne sera PAS modifié.");
  if (!fiches.length) throw new Error("Aucune fiche terminale détectée. data.js ne sera PAS modifié.");
  const ids = fiches.map(f => normalizeId(f.id));
  if (ids.some((id, i) => ids.indexOf(id) !== i)) throw new Error("IDs de fiches dupliqués détectés. data.js ne sera PAS modifié.");
  if (fiches.some(f => !f.titre || !f.id || !Array.isArray(f.path) || !f.path.length)) throw new Error("Fiches invalides détectées. data.js ne sera PAS modifié.");
  if (fiches.some(f => f.path.some(isExcludedPublicPage))) throw new Error("Une fiche publique contient une page interne exclue (Registres/Audit). data.js ne sera PAS modifié.");
  if (themes.some(theme => isExcludedPublicPage(theme.title))) throw new Error("Une page interne exclue (Registres/Audit) est encore présente parmi les thèmes publics. data.js ne sera PAS modifié.");
  if (!sameId(root.id, CONFIGURED_ROOT_ID)) console.log("ℹ️ Racine canonique différente de l'ID configuré : la racine validée par son titre est utilisée.");
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture de l'arborescence réelle, puis reconstruction locale...");

const canonicalRoot = await findCanonicalRoot();
const rootBlocks = await getChildren(canonicalRoot.id);
const excludedRootPages = rootBlocks
  .filter(block => block.type === "child_page" && isExcludedPublicPage(childPageTitle(block)))
  .map(childPageTitle);
const rootPages = rootBlocks
  .filter(block => block.type === "child_page" && childPageTitle(block))
  .filter(block => !isExcludedPublicPage(childPageTitle(block)));
const root = { id: canonicalRoot.id, title: canonicalRoot.title, parentId: null, depth: 0, path: [canonicalRoot.title], type: "root", children: [] };

console.log(`📂 Pages directement sous la racine : ${rootPages.length}`);
if (excludedRootPages.length) console.log(`🚫 Pages internes exclues : ${excludedRootPages.join(", ")}`);
root.children = (await Promise.all(rootPages.map(child => buildNode(child.id, childPageTitle(child), canonicalRoot.id, 1, [canonicalRoot.title])))).filter(Boolean);
sortTree(root);

const numberedThemes = root.children.filter(node => parseNumberedTitle(node.title));
const specialThemes = root.children.filter(node => isPublicSpecialTheme(node.title));
const themes = [...numberedThemes, ...specialThemes];
const fiches = themes.flatMap(theme => flattenFiches(theme));
const totalNodes = themes.reduce((sum, theme) => sum + countNodes(theme), 0);
const deepest = themes.length ? Math.max(...themes.map(maxDepth)) : 0;
const withContent = fiches.filter(fiche => fiche.html).length;

console.log(`🏛️ Thèmes numérotés détectés : ${numberedThemes.length}`);
console.log(`🔵 Rubriques transversales publiques : ${specialThemes.length}`);
console.log(`🧭 Nœuds documentaires : ${totalNodes}`);
console.log(`📝 Fiches terminales : ${fiches.length}`);
console.log(`📦 Fiches avec contenu : ${withContent}/${fiches.length}`);
console.log(`↕️ Profondeur maximale : ${deepest}`);

assertTree(root, themes, fiches);
if (!withContent) throw new Error("Aucune fiche avec contenu. data.js ne sera PAS modifié.");
if (withContent < Math.max(1, Math.floor(fiches.length * 0.5))) throw new Error(`Seulement ${withContent}/${fiches.length} fiches ont du contenu : seuil de sécurité non atteint. data.js ne sera PAS modifié.`);

const output = `// Données générées depuis Notion — ne pas modifier manuellement.\nconst SITE_DATA = ${JSON.stringify({ root, themes, fiches }, null, 2)};\n`;
await fs.writeFile(TEMP_FILE, output, "utf8");
const verification = await fs.readFile(TEMP_FILE, "utf8");
if (!verification.includes("const SITE_DATA =") || !verification.includes('"fiches"')) throw new Error("Vérification du fichier temporaire échouée. data.js existant conservé.");
await fs.rename(TEMP_FILE, OUTPUT_FILE);
console.log(`✅ ${OUTPUT_FILE} généré atomiquement avec ${fiches.length} fiches.`);
