// Labelled evaluation set for githippo. Hand-written to look like a real working memory: people,
// projects, topics, decisions, some notes in Spanish. Queries are labelled with the file that should come
// back. Kept independent of the code under test: nothing here was tuned against results.
const fm = (name, title, description, aliases = []) => `---\nname: ${name}\ntitle: ${title}\ndescription: ${description}\naliases: [${aliases.join(", ")}]\n---\n\n`;

export const VAULT = {
  "people/sam-okafor.md": fm("sam-okafor", "Sam Okafor", "Tech lead, payments team", ["Sam"]) + "- Leads the payments team since March\n- Prefers written RFCs over meetings for design decisions\n- owns:: [[billing-v2]]\n- On parental leave in December\n",
  "people/priya-raman.md": fm("priya-raman", "Priya Raman", "Head of data platform", ["Priya"]) + "- Runs the data platform and the warehouse migration\n- Wants dashboards reviewed before every quarterly business review\n- leads:: [[warehouse-migration]]\n- Based in Bangalore, works IST hours\n",
  "people/lucia-ferrer.md": fm("lucia-ferrer", "Lucía Ferrer", "Directora de marketing", ["Lucía", "Lucia"]) + "- Responsable de la newsletter semanal y de las redes sociales\n- Prefiere recibir los borradores el jueves antes de las 12\n- Habla español e inglés\n",
  "people/tom-becker.md": fm("tom-becker", "Tom Becker", "Security engineer", ["Tom"]) + "- Runs the quarterly penetration test with an external firm\n- Rotates the production database credentials every 90 days\n- Must sign off on any new third-party integration\n",
  "people/mei-chen.md": fm("mei-chen", "Mei Chen", "Mobile engineer", ["Mei"]) + "- Builds the iOS app in SwiftUI\n- Owns push notifications and the offline cache\n- works_on:: [[mobile-app]]\n",
  "people/diego-alvarez.md": fm("diego-alvarez", "Diego Álvarez", "Compliance officer", ["Diego"]) + "- Approves every client-facing message before it is sent\n- Requires two-person review for wire transfers above 50k EUR\n",
  "projects/billing-v2.md": fm("billing-v2", "Billing v2", "Rewrite of the billing and invoicing system", ["billing rewrite"]) + "## Decisions\n- Use idempotency keys on every write endpoint\n- Invoices are generated as PDF and archived for 10 years\n- Launch target is the end of Q2\n- owner:: [[sam-okafor]]\n## Notes\n- handleRefundWebhook is still a stub\n- Stripe is the only payment provider for now\n",
  "projects/warehouse-migration.md": fm("warehouse-migration", "Warehouse migration", "Moving analytics from Redshift to BigQuery", []) + "- Moving all analytics tables from Redshift to BigQuery\n- Cutover planned for the first weekend of November\n- dbt models must pass tests before cutover\n- owner:: [[priya-raman]]\n",
  "projects/mobile-app.md": fm("mobile-app", "Mobile app", "Customer-facing iOS and Android app", ["the app"]) + "- Minimum supported iOS version is 16\n- Android release uses staged rollout at 10 percent first\n- Crash-free sessions target is 99.5 percent\n",
  "projects/johnny.md": fm("johnny", "Johnny", "Voice assistant for the Mac", ["voice agent"]) + "- Needs a wake word and runs locally on the Mac mini\n- Uses Whisper for speech to text\n- Sample rate is 16 kHz\n",
  "projects/newsletter.md": fm("newsletter", "Newsletter", "Boletín semanal para clientes", ["boletín"]) + "- Se envía cada lunes a las 8:00\n- Incluye una sección de mercados y una de producto\n- La revisa [[lucia-ferrer]] antes de enviarla\n",
  "projects/onboarding-revamp.md": fm("onboarding-revamp", "Onboarding revamp", "Redesign of new-customer onboarding", []) + "- Goal is to cut time to first transaction from 6 days to 2\n- KYC checks move to a single screen\n- A/B test runs for four weeks\n",
  "topics/brand.md": fm("brand", "Brand", "Brand and visual identity rules", []) + "- Primary colour is navy with gold accents\n- Logo must have clear space equal to its height\n- Never use stock photos of handshakes\n",
  "topics/infrastructure.md": fm("infrastructure", "Infrastructure", "Hosting, deploys and on-call", ["infra"]) + "- Production runs on Kubernetes in eu-west-1\n- Deploys happen through GitHub Actions with manual approval\n- On-call rotation is weekly and starts on Monday\n- Postgres 16 is the main database\n",
  "topics/writing-style.md": fm("writing-style", "Writing style", "How the user wants text written", []) + "- Prefers British English spelling\n- No exclamation marks in client emails\n- Keep summaries under five bullet points\n",
  "topics/hiring.md": fm("hiring", "Hiring", "Recruiting process and open roles", []) + "- Every candidate gets a take-home task capped at three hours\n- Two open roles: senior backend engineer and data analyst\n",
  "topics/oficina.md": fm("oficina", "Oficina", "Oficina de Madrid", ["Madrid office"]) + "- La oficina de Madrid está en la calle Serrano\n- El aparcamiento se reserva con un día de antelación\n- Los viernes se trabaja en remoto\n",
  "decisions/2026-observability.md": fm("2026-observability", "Observability vendor", "Decision: move from Datadog to Grafana Cloud", []) + "- Moving from Datadog to Grafana Cloud to cut costs by about 40 percent\n- Migration finishes before the end of the year\n",
  "decisions/2026-ai-policy.md": fm("2026-ai-policy", "AI usage policy", "Decision on using AI assistants at work", []) + "- Client data must never be pasted into consumer AI tools\n- Approved assistants run with zero data retention\n",
};

// [query, expected file, type]
export const QUERIES = [
  // exact terms (keywords the note actually contains)
  ["idempotency keys", "projects/billing-v2.md", "exact"],
  ["Whisper speech to text", "projects/johnny.md", "exact"],
  ["Redshift BigQuery", "projects/warehouse-migration.md", "exact"],
  ["Grafana Cloud", "decisions/2026-observability.md", "exact"],
  ["penetration test", "people/tom-becker.md", "exact"],
  ["SwiftUI", "people/mei-chen.md", "exact"],
  ["staged rollout", "projects/mobile-app.md", "exact"],
  ["take-home task", "topics/hiring.md", "exact"],
  ["Kubernetes eu-west-1", "topics/infrastructure.md", "exact"],
  ["wire transfers", "people/diego-alvarez.md", "exact"],
  // paraphrases (same meaning, different words)
  ["which cloud region do we host production in", "topics/infrastructure.md", "paraphrase"],
  ["how long do we keep invoices", "projects/billing-v2.md", "paraphrase"],
  ["what does the voice assistant need to start listening", "projects/johnny.md", "paraphrase"],
  ["who checks messages to clients before they go out", "people/diego-alvarez.md", "paraphrase"],
  ["what spelling should I use", "topics/writing-style.md", "paraphrase"],
  ["when do we switch over to the new data warehouse", "projects/warehouse-migration.md", "paraphrase"],
  ["oldest iPhone software we still support", "projects/mobile-app.md", "paraphrase"],
  ["are we allowed to put customer information into ChatGPT", "decisions/2026-ai-policy.md", "paraphrase"],
  ["why are we leaving our monitoring provider", "decisions/2026-observability.md", "paraphrase"],
  ["how quickly should new customers make their first payment", "projects/onboarding-revamp.md", "paraphrase"],
  ["what pictures are banned in marketing material", "topics/brand.md", "paraphrase"],
  ["who changes the database passwords", "people/tom-becker.md", "paraphrase"],
  // cross-language: Spanish question, English note
  ["¿Qué necesita el asistente de voz para activarse?", "projects/johnny.md", "es→en"],
  ["¿Cuál es el color principal de la marca?", "topics/brand.md", "es→en"],
  ["¿Dónde se ejecuta producción?", "topics/infrastructure.md", "es→en"],
  ["¿Cuánto tiempo guardamos las facturas?", "projects/billing-v2.md", "es→en"],
  ["¿Quién aprueba los mensajes a clientes?", "people/diego-alvarez.md", "es→en"],
  ["¿Cuándo es la migración del almacén de datos?", "projects/warehouse-migration.md", "es→en"],
  ["¿Podemos usar datos de clientes en herramientas de IA?", "decisions/2026-ai-policy.md", "es→en"],
  ["¿Qué ortografía inglesa prefiere el usuario?", "topics/writing-style.md", "es→en"],
  // cross-language: English question, Spanish note
  ["when does the weekly newsletter go out", "projects/newsletter.md", "en→es"],
  ["where is the Madrid office", "topics/oficina.md", "en→es"],
  ["who is in charge of social media", "people/lucia-ferrer.md", "en→es"],
  ["do we work from home on Fridays", "topics/oficina.md", "en→es"],
  ["when should drafts reach the marketing director", "people/lucia-ferrer.md", "en→es"],
  // other languages → English notes (added in v3.4 to measure multilingual support; no thresholds tuned on them)
  ["Quelle est la couleur principale de la marque ?", "topics/brand.md", "fr/de/pt/it→en"],
  ["Combien de temps gardons-nous les factures ?", "projects/billing-v2.md", "fr/de/pt/it→en"],
  ["Wo läuft die Produktionsumgebung?", "topics/infrastructure.md", "fr/de/pt/it→en"],
  ["Wer genehmigt Nachrichten an Kunden?", "people/diego-alvarez.md", "fr/de/pt/it→en"],
  ["Qual é a versão mínima do iOS suportada?", "projects/mobile-app.md", "fr/de/pt/it→en"],
  ["Possiamo usare i dati dei clienti negli strumenti di IA?", "decisions/2026-ai-policy.md", "fr/de/pt/it→en"],
  // identifiers and code
  ["handleRefundWebhook", "projects/billing-v2.md", "code"],
  ["refund webhook stub", "projects/billing-v2.md", "code"],
  ["dbt models tests", "projects/warehouse-migration.md", "code"],
  ["Postgres 16", "topics/infrastructure.md", "code"],
  // names and aliases
  ["Sam", "people/sam-okafor.md", "entity"],
  ["Priya", "people/priya-raman.md", "entity"],
  ["Lucía", "people/lucia-ferrer.md", "entity"],
  ["billing rewrite", "projects/billing-v2.md", "entity"],
  // relations (answer lives in a linked file)
  ["who owns the billing project", "people/sam-okafor.md", "graph"],
  ["who leads the warehouse migration", "people/priya-raman.md", "graph"],
  ["who reviews the newsletter", "people/lucia-ferrer.md", "graph"],
];

// [fact, expected destination file] — what `remember` should do with no `about` given
export const ROUTING = [
  ["Sam wants the billing launch moved to Q3", "people/sam-okafor.md"],
  ["Priya asked for a dbt test coverage report", "people/priya-raman.md"],
  ["Johnny should also understand Catalan", "projects/johnny.md"],
  ["The mobile app needs dark mode before the next release", "projects/mobile-app.md"],
  ["Tom requires a security review for the new SMS vendor", "people/tom-becker.md"],
  ["Invoices must include the customer's VAT number", "projects/billing-v2.md"],
  ["Logo files live in the shared design drive", "topics/brand.md"],
  ["On-call engineers get a day off after a weekend incident", "topics/infrastructure.md"],
  ["Use the Oxford comma in documentation", "topics/writing-style.md"],
  ["La newsletter necesita una sección de eventos", "projects/newsletter.md"],
  ["Likes to listen to jazz while coding", "inbox.md"],
  ["Bought a new standing desk", "inbox.md"],
];

// [new fact, existing fact it relates to, expected: "duplicate" | "update" | "new"]
export const DEDUPE = [
  ["Invoices are archived as PDF for 10 years", "Invoices are generated as PDF and archived for 10 years", "duplicate"],
  ["Sample rate for Johnny is 16 kHz", "Sample rate is 16 kHz", "duplicate"],
  ["Production is hosted on Kubernetes in eu-west-1", "Production runs on Kubernetes in eu-west-1", "duplicate"],
  ["Launch target is the end of Q3", "Launch target is the end of Q2", "update"],
  ["Sample rate is 48 kHz", "Sample rate is 16 kHz", "update"],
  ["Minimum supported iOS version is 17", "Minimum supported iOS version is 16", "update"],
  ["Cutover planned for the first weekend of December", "Cutover planned for the first weekend of November", "update"],
  ["Postgres 17 is the main database", "Postgres 16 is the main database", "update"],
  ["Crash-free sessions target is 99.9 percent", "Crash-free sessions target is 99.5 percent", "update"],
  ["The A/B test needs a holdout group", "A/B test runs for four weeks", "new"],
  ["Deploys are frozen during the last week of December", "Deploys happen through GitHub Actions with manual approval", "new"],
];

// Development set for routing: used to diagnose and tune filing. ROUTING above is the held-out test set
// and is only used to report the final number.
export const DEV_ROUTING = [
  ["Refunds older than 90 days need manual approval", "projects/billing-v2.md"],
  ["Stripe webhooks must be verified with the signing secret", "projects/billing-v2.md"],
  ["BigQuery costs must stay under 2k EUR a month", "projects/warehouse-migration.md"],
  ["Redshift will be switched off a month after cutover", "projects/warehouse-migration.md"],
  ["Push notifications need opt-in on first launch", "projects/mobile-app.md"],
  ["SwiftUI previews are broken on the CI machines", "people/mei-chen.md"],
  ["Whisper large is too slow on the Mac mini", "projects/johnny.md"],
  ["KYC screen should support passport scans", "projects/onboarding-revamp.md"],
  ["Kubernetes nodes are upgraded on the first Tuesday of each month", "topics/infrastructure.md"],
  ["Gold accents should never be used on dark backgrounds", "topics/brand.md"],
  ["Datadog contract ends in January", "decisions/2026-observability.md"],
  ["Zero data retention is required for any AI vendor", "decisions/2026-ai-policy.md"],
  ["Take-home tasks are reviewed by two engineers", "topics/hiring.md"],
  ["Penetration test report is due in March", "people/tom-becker.md"],
  ["El parking de Serrano cierra a las 21:00", "topics/oficina.md"],
  ["Remembered to water the plants", "inbox.md"],
  ["Wants to learn the cello next year", "inbox.md"],
  ["Prefers tea over coffee in the afternoon", "inbox.md"],
  ["Thinks the new Pixar film is great", "inbox.md"],
  ["Read a good article about sleep", "inbox.md"],
];
