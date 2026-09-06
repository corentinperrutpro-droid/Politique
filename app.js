// ===== Données =====
const themes = SITE_DATA.themes || [];
const fiches = SITE_DATA.fiches || [];

const themesContainer = document.getElementById("themes");
const detailView = document.getElementById("detail-view");
const appMain = document.getElementById("app");

// ===== Sécurité HTML =====
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Les fiches historiques contiennent volontairement du HTML éditorial.
// On le nettoie avant insertion dans le DOM afin de ne jamais exécuter de script
// ou d'attribut événementiel provenant des données.
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

// ===== Thèmes =====
function renderThemes(list = themes) {
  if (!themesContainer) return;
  themesContainer.innerHTML = list.map(theme => {
    const number = String(theme.num).padStart(2, "0");
    return `
      <article class="theme-card" tabindex="0" role="link" data-theme="${Number(theme.num)}">
        <span class="theme-number">${number}</span>
        <h3>${escapeHtml(theme.titre)}</h3>
      </article>
    `;
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

function openTheme(num) {
  window.location.hash = `theme/${encodeURIComponent(num)}`;
}

function openFiche(id) {
  window.location.hash = `fiche/${encodeURIComponent(id)}`;
}

// ===== Recherche =====
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

  const themeMatches = themes.filter(t =>
    String(t.titre || "").toLowerCase().includes(query)
  );

  const categoryMatches = [];
  themes.forEach(t => (t.categories || []).forEach(c => {
    if (String(c.nom || "").toLowerCase().includes(query)) {
      categoryMatches.push({ themeNum: t.num, themeTitre: t.titre, code: c.code, nom: c.nom });
    }
  }));

  // Recherche désormais dans le titre, la catégorie, le thème ET le texte intégral.
  const ficheMatches = fiches.filter(f => {
    const haystack = [f.titre, f.cat, f.theme, f.html]
      .map(value => String(value ?? ""))
      .join(" ");
    return haystack.toLowerCase().includes(query);
  });

  if (!themeMatches.length && !categoryMatches.length && !ficheMatches.length) {
    results.innerHTML = `<p class="search-result">Aucun résultat pour <strong>${escapeHtml(rawQuery)}</strong>.</p>`;
    return;
  }

  let html = "";
  themeMatches.forEach(t => {
    const number = String(t.num).padStart(2, "0");
    html += `
      <a class="search-result" href="#theme/${encodeURIComponent(t.num)}">
        <span class="search-result-number">THÈME ${number}</span>
        <h3>${escapeHtml(t.titre)}</h3>
        <p>Ouvrir la rubrique documentaire.</p>
      </a>`;
  });

  categoryMatches.slice(0, 20).forEach(c => {
    html += `
      <a class="search-result" href="#theme/${encodeURIComponent(c.themeNum)}">
        <span class="search-result-number">CATÉGORIE ${escapeHtml(c.code)}</span>
        <h3>${escapeHtml(c.nom)}</h3>
        <p>Dans : ${escapeHtml(c.themeTitre)}</p>
      </a>`;
  });

  ficheMatches.slice(0, 30).forEach(f => {
    const ficheId = String(f.id);
    html += `
      <a class="search-result" href="#fiche/${encodeURIComponent(ficheId)}">
        <span class="search-result-number">FICHE · ${escapeHtml(f.cat || "")}</span>
        <h3>${escapeHtml(f.titre)}</h3>
        <p>Texte intégral disponible${f.html ? " · recherche dans le contenu activée" : ""}.</p>
      </a>`;
  });

  results.innerHTML = html;
}

// ===== Menu mobile =====
function toggleMenu() {
  document.querySelector(".nav")?.classList.toggle("open");
}

// ===== Raccourcis clavier =====
document.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  if (document.activeElement?.id === "home-search") searchSite();
  if (document.activeElement?.id === "search-input") runSearch();
});

// ===== Vue détail : thème =====
function renderThemeDetail(num) {
  const t = themes.find(theme => Number(theme.num) === Number(num));
  if (!t) return `<p>Thème introuvable.</p>`;

  const number = String(t.num).padStart(2, "0");
  let html = `
    <div class="detail-breadcrumb">
      <a href="#explorer">← Retour à la carte politique</a>
    </div>
    <div class="detail-head">
      <span class="eyebrow">THÈME ${number} · BASE FACTUELLE</span>
      <h1 class="detail-title">${escapeHtml(t.titre)}</h1>
      <p class="detail-meta">≈${Number(t.fiches) || 0} fiches actives
        ${t.notionId ? ` · <a href="https://app.notion.com/p/${encodeURIComponent(t.notionId)}" target="_blank" rel="noopener noreferrer">ouvrir dans Notion →</a>` : ""}
      </p>
      <p class="detail-status">${escapeHtml(t.statut || "")}</p>
    </div>
    <div class="detail-categories">`;

  (t.categories || []).forEach(c => {
    const fichesHere = fiches.filter(f => {
      const cat = String(f.cat || "");
      return cat === c.code || cat.startsWith(`${c.code}.`);
    });

    html += `
      <article class="category-row">
        <span class="category-code">${escapeHtml(c.code)}</span>
        <div class="category-body">
          <h3>${escapeHtml(c.nom)}</h3>`;

    if (fichesHere.length) {
      html += `<div class="fiche-links">${fichesHere.map(f => `
        <a class="fiche-link" href="#fiche/${encodeURIComponent(String(f.id))}">
          📄 ${escapeHtml(f.titre)}
        </a>`).join("")}</div>`;
    } else {
      html += `<p class="category-empty">Détail fiche par fiche non encore intégré à ce site — consulter Notion pour le contenu complet.</p>`;
    }

    html += `</div></article>`;
  });

  return `${html}</div>`;
}

// ===== Vue détail : fiche =====
function renderFicheDetail(id) {
  let decodedId;
  try { decodedId = decodeURIComponent(id); } catch { decodedId = id; }

  const f = fiches.find(x => String(x.id) === String(decodedId));
  if (!f) return `<p>Fiche introuvable. <a href="#explorer">Retour</a></p>`;

  const theme = themes.find(t => Number(t.num) === Number(f.theme));
  return `
    <div class="detail-breadcrumb">
      <a href="#theme/${encodeURIComponent(f.theme)}">← Retour au thème ${theme ? escapeHtml(theme.titre) : escapeHtml(f.theme)}</a>
    </div>
    <div class="detail-head">
      <span class="eyebrow">FICHE · ${escapeHtml(f.cat || "")}</span>
      <h1 class="detail-title fiche-title">${escapeHtml(f.titre)}</h1>
    </div>
    <div class="fiche-body">
      ${sanitizeFicheHtml(f.html || "")}
    </div>`;
}

// ===== Routeur =====
function router() {
  const hash = (window.location.hash || "").slice(1);
  if (hash.startsWith("theme/")) {
    const num = Number(decodeURIComponent(hash.slice(6)));
    detailView.innerHTML = renderThemeDetail(num);
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