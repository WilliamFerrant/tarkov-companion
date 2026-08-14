/**
 * scripts/verify-api.mjs
 * ----------------------
 * Verification autonome des sources de donnees, sans lancer Electron.
 *
 * A executer en cas de doute : « l'outil n'affiche plus de prix, est-ce moi ou
 * est-ce l'API ? ». Le script controle les deux sources :
 *
 *   1. API JSON (https://json.tarkov.dev) — la source active.
 *   2. API GraphQL (https://api.tarkov.dev/graphql) — hors service depuis
 *      juillet 2026, conservee comme repli.
 *
 * Usage : `npm run verify-api`
 */

const JSON_BASE = 'https://json.tarkov.dev';
const GRAPHQL_ENDPOINT = 'https://api.tarkov.dev/graphql';

const ok = (msg) => console.log(`  [OK]    ${msg}`);
const ko = (msg) => console.log(`  [ECHEC] ${msg}`);
const info = (msg) => console.log(`  ->      ${msg}`);

let failures = 0;

async function getJson(url, timeoutMs = 90_000) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'tarkov-price-hover/1.0 (personal use)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

/** Reconstruit le nom d'affichage depuis l'URL du wiki (voir TarkovJsonApi.ts). */
function nameFromWikiLink(wikiLink) {
  if (typeof wikiLink !== 'string') return null;
  const last = wikiLink.split('/').pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last).replace(/_/g, ' ').trim();
  } catch {
    return last.replace(/_/g, ' ').trim();
  }
}

async function checkJsonApi() {
  console.log(`\n=== API JSON (source active) — ${JSON_BASE} ===\n`);

  // --- 1. Endpoints et modes de jeu ---
  console.log('1. Catalogue des endpoints');
  let gameModes = [];
  try {
    const payload = await getJson(`${JSON_BASE}/endpoints`, 30_000);
    const data = payload.data ?? payload;
    gameModes = data.gameModes ?? [];
    ok(`${(data.endpoints ?? []).length} endpoints, modes : ${gameModes.join(', ')}`);
    for (const required of ['regular', 'pve']) {
      if (!gameModes.includes(required)) {
        ko(`mode « ${required} » absent`);
        failures++;
      }
    }
  } catch (err) {
    ko(String(err.message ?? err));
    failures++;
    return;
  }

  // --- 2. Traders ---
  console.log('\n2. Table des traders (noms des acheteurs)');
  let traderCount = 0;
  try {
    const payload = await getJson(`${JSON_BASE}/regular/traders`);
    const traders = Object.values(payload.data ?? {});
    traderCount = traders.filter((t) => typeof t?.normalizedName === 'string').length;
    if (traderCount === 0) {
      ko('aucun trader avec un normalizedName exploitable');
      failures++;
    } else {
      ok(`${traderCount} traders : ${traders.slice(0, 6).map((t) => t.normalizedName).join(', ')}…`);
    }
  } catch (err) {
    ko(String(err.message ?? err));
    failures++;
  }

  // --- 3. Items, par mode de jeu ---
  for (const mode of ['regular', 'pve']) {
    console.log(`\n3. Items — mode ${mode}`);
    try {
      const started = Date.now();
      const payload = await getJson(`${JSON_BASE}/${mode}/items`);
      const items = Object.values(payload?.data?.items ?? {});
      if (items.length === 0) {
        ko('aucun item renvoye');
        failures++;
        continue;
      }
      ok(`${items.length} items en ${Date.now() - started} ms`);

      // Champs consommes par l'application.
      const missing = [];
      for (const field of ['id', 'normalizedName', 'basePrice', 'width', 'height', 'types', 'sellToTrader']) {
        if (items.every((i) => i[field] === undefined)) missing.push(field);
      }
      if (missing.length > 0) {
        ko(`champs absents de tous les items : ${missing.join(', ')}`);
        failures++;
      } else {
        ok('tous les champs requis sont presents');
      }

      // Les noms doivent etre reconstructibles : c'est la particularite de cette API.
      const withWiki = items.filter((i) => nameFromWikiLink(i.wikiLink)).length;
      const withSlug = items.filter((i) => typeof i.normalizedName === 'string' && i.normalizedName.length > 2).length;
      const coverage = (withSlug / items.length) * 100;
      if (coverage < 99) {
        ko(`normalizedName exploitable sur seulement ${coverage.toFixed(1)} % des items`);
        failures++;
      } else {
        ok(`noms : ${withWiki} via wikiLink, ${items.length - withWiki} deduits du slug (couverture ${coverage.toFixed(1)} %)`);
      }

      const withFlea = items.filter((i) => i.avg24hPrice > 0).length;
      info(`${withFlea} items ont un prix Flea sur 24 h`);

      const sample = items.find((i) => i.normalizedName === 'ledx-skin-transilluminator');
      if (sample) {
        const trader = (sample.sellToTrader ?? []).reduce((a, b) => (b.priceRUB > (a?.priceRUB ?? 0) ? b : a), null);
        info(
          `controle « ${nameFromWikiLink(sample.wikiLink)} » : avg24h ${sample.avg24hPrice}, ` +
            `${sample.width}x${sample.height}, meilleur trader ${trader?.priceRUB ?? '—'}`,
        );
      }
    } catch (err) {
      ko(String(err.message ?? err));
      failures++;
    }
  }
}

async function checkGraphqlApi() {
  console.log(`\n=== API GraphQL (repli) — ${GRAPHQL_ENDPOINT} ===\n`);
  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: '{ items(name: "salewa") { id name avg24hPrice } }' }),
      signal: AbortSignal.timeout(45_000),
    });
    const body = await response.text();

    if (!response.ok) {
      // Panne connue et documentee : ce n'est pas un echec de l'outil.
      info(`indisponible — HTTP ${response.status} : ${body.slice(0, 120)}`);
      info('Panne cote tarkov.dev depuis juillet 2026 (issue the-hideout/tarkov-api#474).');
      info("Sans consequence : l'application utilise l'API JSON.");
      return;
    }

    const payload = JSON.parse(body);
    if (payload.errors?.length) {
      info(`erreurs GraphQL : ${JSON.stringify(payload.errors).slice(0, 160)}`);
      return;
    }
    ok(`de nouveau en service — ${payload.data.items.length} resultat(s) pour « salewa »`);
    info('Le repli GraphQL est a nouveau operationnel.');
  } catch (err) {
    info(`injoignable : ${String(err.message ?? err)}`);
    info("Sans consequence : l'application utilise l'API JSON.");
  }
}

async function main() {
  await checkJsonApi();
  await checkGraphqlApi();

  console.log(
    failures === 0
      ? "\nResultat : la source active repond et fournit tout ce qu'attend l'application.\n"
      : `\nResultat : ${failures} probleme(s) sur la source active. Voir les messages ci-dessus.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nErreur inattendue :', err);
  process.exitCode = 1;
});
