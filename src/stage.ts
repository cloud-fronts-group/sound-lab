// Decorative artwork for the DJ-booth editor: a crowd-on-the-horizon banner and two vinyl decks.
// All colours come from CSS classes / custom properties in media/editor.css (no style attributes: strict CSP),
// and everything is aria-hidden: the real controls are the HTML buttons around it.

/** Small seeded PRNG so the crowd is identical on every load. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const n = (v: number): string => String(Math.round(v * 10) / 10);

interface CrowdRow { y: number; r: number; arms: number }
// Far to near: smaller, denser, closer to the horizon (y=120) first. The nearest row is cropped by the banner edge.
const CROWD_ROWS: CrowdRow[] = [
  { y: 121, r: 1.4, arms: 0.10 },
  { y: 130, r: 2.2, arms: 0.14 },
  { y: 144, r: 3.4, arms: 0.16 },
  { y: 166, r: 5.4, arms: 0.20 },
];

function crowdRow(row: CrowdRow, index: number, rand: () => number): string {
  const gap = row.r * 5;
  let body = '';
  let arms = '';
  for (let x = rand() * gap; x < 1220; x += gap * (0.8 + rand() * 0.4)) {
    const r = row.r * (0.88 + rand() * 0.28);
    const y = row.y + (rand() - 0.5) * row.r * 0.6;
    body += `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
    body += `M${n(x - 1.9 * r)} ${n(y + 8.2 * r)}v${n(-4.6 * r)}q0 ${n(-2 * r)} ${n(1.9 * r)} ${n(-2 * r)}q${n(1.9 * r)} 0 ${n(1.9 * r)} ${n(2 * r)}v${n(4.6 * r)}z`; // rounded shoulders
    if (rand() < row.arms) {
      const lean = (rand() - 0.5) * 2 * r;
      arms += `M${n(x + 1.3 * r)} ${n(y + 2.6 * r)}l${n(lean)} ${n(-4.4 * r)}`;
    }
  }
  return `<g class="row r${index}"><path class="crowd" d="${body}"/><path class="arms" stroke-width="${n(row.r * 0.55)}" d="${arms}"/></g>`;
}

/** Wide banner: dusk sky, setting orb, far-off stage with light beams, and a crowd stretching to the horizon. */
export function stageSvg(): string {
  const rand = rng(20261102);
  const stars = Array.from({ length: 46 }, () => `<circle class="star" cx="${n(rand() * 1200)}" cy="${n(rand() * 96)}" r="${n(0.5 + rand() * 0.9)}"/>`).join('');
  const rows = CROWD_ROWS.map((r, i) => crowdRow(r, i, rand));
  const lamps = Array.from({ length: 18 }, (_, i) => `<circle class="lamp l${i % 4}" cx="${n(40 + rand() * 1120)}" cy="${n(138 + rand() * 34)}" r="${n(1.2 + rand() * 1.1)}"/>`).join('');
  const beam = (cls: string, x: number, dx: number, accent: string) =>
    `<polygon class="beam ${cls} ${accent}" points="${x - 4},120 ${x + 4},120 ${x + dx + 70},0 ${x + dx - 70},0" fill="url(#sl-beam-${accent})"/>`;
  return `<svg class="scene" viewBox="0 0 1200 180" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
<defs>
<linearGradient id="sl-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="sk0"/><stop offset="0.55" class="sk1"/><stop offset="0.85" class="sk2"/><stop offset="1" class="sk3"/></linearGradient>
<radialGradient id="sl-glow"><stop offset="0" class="gl0"/><stop offset="1" class="gl1"/></radialGradient>
<linearGradient id="sl-beam-a" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="ba0"/><stop offset="1" class="ba1"/></linearGradient>
<linearGradient id="sl-beam-b" x1="0" y1="1" x2="0" y2="0"><stop offset="0" class="bb0"/><stop offset="1" class="bb1"/></linearGradient>
<linearGradient id="sl-ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="gr0"/><stop offset="1" class="gr1"/></linearGradient>
<linearGradient id="sl-haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="hz1"/><stop offset="0.5" class="hz0"/><stop offset="1" class="hz1"/></linearGradient>
</defs>
<rect width="1200" height="122" fill="url(#sl-sky)"/>
${stars}
<circle class="glow" cx="600" cy="120" r="150" fill="url(#sl-glow)"/>
<circle class="orb" cx="600" cy="124" r="40"/>
${beam('b1', 300, 60, 'a')}${beam('b2', 470, -40, 'b')}${beam('b3', 730, 40, 'a')}${beam('b4', 900, -60, 'b')}
<path class="hills" d="M0 120V113c90-9 160-4 250 2s150-8 260-5 140 8 260 3 200-10 300-3 140 4 130 8v2z"/>
<rect class="ground" y="119" width="1200" height="61" fill="url(#sl-ground)"/>
<g class="farstage"><rect x="556" y="108" width="88" height="12"/><rect class="led" x="562" y="111" width="76" height="4"/><path d="M552 120l6-22h6l-4 22zM636 120l-4-22h6l6 22z"/></g>
${rows[0]}${rows[1]}
<rect class="haze" y="108" width="1200" height="44" fill="url(#sl-haze)"/>
${rows[2]}${rows[3]}
${lamps}
</svg>`;
}

/** One vinyl turntable. The `.spin` group turns at 33⅓ RPM while the deck has class `on`; the tonearm drops onto the record. */
export function deckSvg(letter: 'A' | 'B'): string {
  const gloss = `sl-gloss-${letter}`;
  let grooves = '';
  for (let r = 36; r <= 84; r += 3) { grooves += `<circle class="${r % 12 === 0 ? 'gv gv2' : 'gv'}" cx="110" cy="112" r="${r}"/>`; }
  return `<svg class="deck-art deck-${letter.toLowerCase()}" viewBox="0 0 240 220" aria-hidden="true" focusable="false">
<defs><linearGradient id="${gloss}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="gs0"/><stop offset="1" class="gs1"/></linearGradient></defs>
<rect class="plinth" x="4" y="4" width="232" height="212" rx="14"/>
<circle class="screw" cx="16" cy="16" r="3"/><circle class="screw" cx="224" cy="204" r="3"/><circle class="screw" cx="16" cy="204" r="3"/>
<circle class="platter" cx="110" cy="112" r="95"/>
<circle class="strobe" cx="110" cy="112" r="91"/>
<g class="spin">
<circle class="vinyl" cx="110" cy="112" r="86"/>
${grooves}
<circle class="spiral" cx="110" cy="112" r="62"/>
<circle class="label" cx="110" cy="112" r="30"/>
<path class="labelhalf" d="M110 82a30 30 0 0 1 0 60z"/>
<circle class="labelring" cx="110" cy="112" r="24"/>
<text class="lbl" x="110" y="113" text-anchor="middle" dominant-baseline="central">${letter}</text>
</g>
<path fill="url(#${gloss})" d="M110 112L110 26A86 86 0 0 1 184 69zM110 112L110 198A86 86 0 0 1 36 155z"/>
<circle class="spindle" cx="110" cy="112" r="3.5"/>
<circle class="deckled" cx="24" cy="196" r="3.5"/><text class="rpm" x="32" y="199">33⅓</text>
<rect class="rest" x="209" y="133" width="14" height="10" rx="2"/>
<g class="arm">
<line class="armback" x1="208" y1="36" x2="219" y2="18"/><circle class="cw" cx="219" cy="18" r="6.5"/>
<line class="armtube" x1="208" y1="36" x2="156" y2="124"/>
<line class="armshine" x1="206" y1="35" x2="155" y2="122"/>
<polygon class="cart" points="150.8,120.9 161.2,127.1 154.1,139.1 143.7,132.9"/>
</g>
<circle class="pivot" cx="208" cy="36" r="15"/><circle class="pivot2" cx="208" cy="36" r="7"/>
</svg>`;
}
