// ===== Données =====
const siteRoot = SITE_DATA.root || null;
const themes = SITE_DATA.themes || [];
const fiches = SITE_DATA.fiches || [];

const themesContainer = document.getElementById("themes");
const detailView = document.getElementById("detail-view");
const appMain = document.getElementById("app");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeFicheHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value ?? "");
  const allowedTags = new Set([
    "P", "BR", "H2", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM",
    "BLOCKQUOTE", "A", "CODE", "PRE", "HR", "TABLE", "THEAD", "TBODY",
    "TR", "TH", "TD", "FIGURE", "FIGCAPTION", "IMG", "DIV", "SPAN"
  ]);
  const allowedAttrs = new Set(["href", "src", "alt", "title", "target", "rel"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(...Array.from(node.childNodes));
      return;
    }
    Array.from(node.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (!allowedAttrs.has(name) || name.startsWith("on")) {
        node.removeAttribute(attr.name);
        return;
      }
      if ((name === "href" || name === "src") && !/^(https?:|mailto:|#|\/)/i.test(value)) {
        node.removeAttribute(attr.name);
      }
    });
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  return template.innerHTML;
}

function htmlToSearchText(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value ?? "");
  return (template.content.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function nodeFicheCount(node) {
  return fiches.filter(fiche => fiche.path?.includes(node.title)).length;
}

function openTheme(id) {
  window.location.hash = `theme/${encodeURIComponent(id)}`;
}

function openFiche(id) {
  window.location.hash = `fiche/${encodeURIComponent(id)}`;
}

function renderThemes(list = themes) {
  if (!themesContainer) return;
  themesContainer.innerHTML = list.map(theme => {
    const parsed = String(theme.title || "").match(/^(\d+)\.\s*(.*)$/u);
    const number = parsed ? String(parsed[1]).padStart(2, "0") : "";
    const title = parsed ? parsed[2] : theme.title;
    return `
      <article class="theme-card" tabindex="0" role="link" data-theme="${escapeHtml(theme.id)}">
        <span class="theme-number">${escapeHtml(number)}</span>
        <h3>${escapeHtml(title)}</h3>
      </article>`;
  }).join("");
}

if (themesContainer) {
  themesContainer.addEventListener("click", event => {
    const card = event.target.closest("[data-theme]");
    if (card) openTheme(card.dataset.theme);
  });
  themesContainer.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-theme]");
    if (card) {
      event.preventDefault();
      openTheme(card.dataset.theme);
    }
  });
}

function searchSite() {
  const input = document.getElementById("home-search");
  const value = input?.value.trim() || "";
  if (!value) {
    document.getElementById("recherche")?.scrollIntoView({ behavior: "smooth" });
    return;
  }
  const searchInput = document.getElementById("search-input");
  if (searchInput) searchInput.value = value;
  runSearch();
  document.getElementById("recherche")?.scrollIntoView({ behavior: "smooth" });
}

function runSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  if (!input || !results) return;
  const rawQuery = input.value.trim();
  const query = rawQuery.toLowerCase();
  if (!query) {
    results.innerHTML = `<p class="search-result">Saisissez un terme pour lancer une recherche.</p>`;
    return;
  }

  const themeMatches = themes.filter(t => String(t.title || "").toLowerCase().includes(query));
  const ficheMatches = fiches.filter(f => {
    const haystack = [f.titre, f.cat, f.theme, f.path?.join(" "), htmlToSearchText(f.html)]
      .map(value => String(value ?? ""))
      .join(" ");
    return haystack.toLowerCase().includes(query);
  });

  if (!themeMatches.length && !ficheMatches.length) {
    results.innerHTML = `<p class="search-result">Aucun résultat pour <strong>${escapeHtml(rawQuery)}</strong>.</p>`;
    return;
  }

  let html = "";
  themeMatches.forEach(t => {
    html += `
      <a class="search-result" href="#theme/${encodeURIComponent(t.id)}">
        <span class="search-result-number">RUBRIQUE</span>
        <h3>${escapeHtml(t.title)}</h3>
        <p>Explorer toute l'arborescence de cette rubrique.</p>
      </a>`;
  });
  ficheMatches.slice(0, 40).forEach(f => {
    html += `
      <a class="search-result" href="#fiche/${encodeURIComponent(String(f.id))}">
        <span class="search-result-number">FICHE</span>
        <h3>${escapeHtml(f.titre)}</h3>
        <p>${escapeHtml((f.path || []).join(" → "))}</p>
      </a>`;
  });
  results.innerHTML = html;
}

function toggleMenu() {
  document.querySelector(".nav")?.classList.toggle("open");
}

document.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  if (document.activeElement?.id === "home-search") searchSite();
  if (document.activeElement?.id === "search-input") runSearch();
});

function breadcrumb(path, extra = "") {
  return `
    <div class="detail-breadcrumb">
      <a href="#explorer">← Retour à la carte politique</a>
      ${extra ? `<span> · ${escapeHtml(extra)}</span>` : ""}
    </div>`;
}

function renderTreeNode(node, level = 0) {
  const children = node.children || [];
  const fiche = node.type === "fiche";
  const indent = Math.min(level, 8);
  if (fiche) {
    return `<a class="fiche-link" href="#fiche/${encodeURIComponent(node.id)}" style="--tree-level:${indent}">📄 ${escapeHtml(node.title)}</a>`;
  }
  return `
    <section class="category-row" style="--tree-level:${indent}">
      <span class="category-code">${level === 0 ? "" : "›"}</span>
      <div class="category-body">
        <h3>${escapeHtml(node.title)}</h3>
        ${children.length
          ? `<div class="fiche-links">${children.map(child => renderTreeNode(child, level + 1)).join("")}</div>`
          : `<p class="category-empty">Aucun élément enfant.</p>`}
      </div>
    </section>`;
}

function renderThemeDetail(id) {
  const theme = themes.find(node => String(node.id) === String(id));
  if (!theme) return `<p>Rubrique introuvable.</p>`;
  const ficheCount = countFichesInNode(theme);
  return `
    ${breadcrumb(theme.path)}
    <div class="detail-head">
      <span class="eyebrow">ARBORESCENCE DOCUMENTAIRE</span>
      <h1 class="detail-title">${escapeHtml(theme.title)}</h1>
      <p class="detail-meta">${ficheCount} fiche${ficheCount > 1 ? "s" : ""} terminale${ficheCount > 1 ? "s" : ""}
        · <a href="https://app.notion.com/p/${encodeURIComponent(theme.id)}" target="_blank" rel="noopener noreferrer">ouvrir dans Notion →</a>
      </p>
    </div>
    <div class="detail-categories">${(theme.children || []).map(child => renderTreeNode(child, 0)).join("")}</div>`;
}

function countFichesInNode(node) {
  if (node.type === "fiche") return 1;
  return (node.children || []).reduce((sum, child) => sum + countFichesInNode(child), 0);
}

function renderFicheDetail(id) {
  let decodedId;
  try { decodedId = decodeURIComponent(id); } catch { decodedId = id; }
  const f = fiches.find(x => String(x.id) === String(decodedId));
  if (!f) return `<p>Fiche introuvable. <a href="#explorer">Retour</a></p>`;
  return `
    ${breadcrumb(f.path?.join(" → ") || "")}
    <div class="detail-head">
      <span class="eyebrow">FICHE DOCUMENTAIRE</span>
      <h1 class="detail-title fiche-title">${escapeHtml(f.titre)}</h1>
      <p class="detail-meta">${escapeHtml((f.path || []).join(" → "))}</p>
    </div>
    <div class="fiche-body">${sanitizeFicheHtml(f.html || "<p>Contenu vide dans Notion.</p>")}</div>`;
}

function router() {
  const hash = (window.location.hash || "").slice(1);
  if (hash.startsWith("theme/")) {
    detailView.innerHTML = renderThemeDetail(hash.slice(6));
    showDetail();
  } else if (hash.startsWith("fiche/")) {
    detailView.innerHTML = renderFicheDetail(hash.slice(6));
    showDetail();
  } else {
    hideDetail();
  }
}

function showDetail() {
  detailView.hidden = false;
  appMain.classList.add("detail-mode");
  window.scrollTo(0, 0);
}

function hideDetail() {
  detailView.hidden = true;
  appMain.classList.remove("detail-mode");
}

window.addEventListener("hashchange", router);
renderThemes();
router();
