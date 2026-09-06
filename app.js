const themes = [
"Institutions & État",
"Finances Publiques",
"Économie & Industrie",
"Énergie & Environnement",
"Défense & Sécurité",
"Social & Cohésion",
"Éducation, Culture & Recherche",
"Santé publique",
"Justice & État de droit",
"Politique étrangère & Géopolitique",
"Agriculture & Alimentation",
"Transport & Mobilité",
"Laïcité & Fait religieux",
"Grand âge & Dépendance",
"Travail & Dialogue social",
"Police nationale & Gendarmerie",
"Vie démocratique & Partis politiques",
"Fonction publique & Réforme de l'État",
"Tourisme",
"Politique de la ville & Banlieues",
"Économie sociale et solidaire (ESS)",
"Risques majeurs & Gestion de crise",
"Mer & Littoral",
"Addictions & conduites à risque",
"Sécurité routière",
"Banque, Crédit & Finance privée",
"Politique familiale & Démographie",
"Sans-abrisme & Grande exclusion",
"Intelligence artificielle & Politiques publiques",
"Adaptation climatique",
"Médias & Liberté de la presse",
"Consommation & Protection du consommateur",
"BTP & Construction",
"Diplomatie économique & Attractivité",
"Hydrogène",
"Politique du Handicap"
];

const themesContainer = document.getElementById("themes");

function renderThemes(list = themes) {

themesContainer.innerHTML = list.map((theme, index) => {

const number = String(index + 1).padStart(2, "0");

return `
  <article
    class="theme-card"
    onclick="openTheme(${index})"
  >

    <span class="theme-number">
      ${number}
    </span>

    <h3>
      ${theme}
    </h3>

  </article>
`;

}).join("");
}

function openTheme(index) {

const theme = themes[index];

window.location.hash =
"theme/${index}";

alert(
"${theme}\n\nCette rubrique accueillera progressivement les sous-thèmes, catégories et sujets documentés."
);
}

function searchSite() {

const input =
document.getElementById("home-search");

const value =
input.value.trim();

if (!value) {

document
  .getElementById("recherche")
  .scrollIntoView({
    behavior: "smooth"
  });

return;

}

document.getElementById("search-input").value =
value;

runSearch();

document
.getElementById("recherche")
.scrollIntoView({
behavior: "smooth"
});
}

function runSearch() {

const input =
document.getElementById("search-input");

const results =
document.getElementById("search-results");

const query =
input.value.trim().toLowerCase();

if (!query) {

results.innerHTML = `
  <p class="search-result">
    Saisissez un terme pour lancer une recherche.
  </p>
`;

return;

}

const matches =
themes.filter(theme =>
theme.toLowerCase().includes(query)
);

if (!matches.length) {

results.innerHTML = `
  <p class="search-result">
    Aucun thème trouvé pour
    <strong>${escapeHtml(input.value)}</strong>.
  </p>
`;

return;

}

results.innerHTML =
matches.map(theme => {

  const index =
    themes.indexOf(theme);

  const number =
    String(index + 1).padStart(2, "0");

  return `
    <a
      class="search-result"
      href="#explorer"
      onclick="openTheme(${index})"
    >

      <span class="search-result-number">
        THÈME ${number}
      </span>

      <h3>
        ${theme}
      </h3>

      <p>
        Ouvrir la rubrique documentaire.
      </p>

    </a>
  `;

}).join("");

}

function escapeHtml(value) {

return value
.replaceAll("&", "&")
.replaceAll("<", "<")
.replaceAll(">", ">")
.replaceAll('"', """)
.replaceAll("'", "'");
}

function toggleMenu() {

const nav =
document.querySelector(".nav");

nav.classList.toggle("open");
}

document.addEventListener(
"keydown",
event => {

if (
  event.key === "Enter" &&
  document.activeElement?.id === "home-search"
) {

  searchSite();

}

}
);

document.addEventListener(
"keydown",
event => {

if (
  event.key === "Enter" &&
  document.activeElement?.id === "search-input"
) {

  runSearch();

}

}
);

renderThemes();
