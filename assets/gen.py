# Generates githippo's brand assets: hero/social banner + animated demo.
import html

HIPPO = '''
<g id="hippo">
  <ellipse cx="0" cy="8" rx="78" ry="70" fill="#8b5cf6"/>
  <ellipse cx="-50" cy="-58" rx="16" ry="20" fill="#7c3aed"/>
  <ellipse cx="50" cy="-58" rx="16" ry="20" fill="#7c3aed"/>
  <ellipse cx="-50" cy="-56" rx="7" ry="10" fill="#c4b5fd"/>
  <ellipse cx="50" cy="-56" rx="7" ry="10" fill="#c4b5fd"/>
  <ellipse cx="0" cy="40" rx="66" ry="44" fill="#c4b5fd"/>
  <ellipse cx="-22" cy="30" rx="8" ry="11" fill="#5b21b6"/>
  <ellipse cx="22" cy="30" rx="8" ry="11" fill="#5b21b6"/>
  <circle cx="-30" cy="-22" r="11" fill="#fff"/>
  <circle cx="30" cy="-22" r="11" fill="#fff"/>
  <circle cx="-27" cy="-20" r="6" fill="#1e1b4b"/>
  <circle cx="33" cy="-20" r="6" fill="#1e1b4b"/>
  <circle cx="-25" cy="-23" r="2" fill="#fff"/>
  <circle cx="35" cy="-23" r="2" fill="#fff"/>
  <path d="M-26 64 Q0 76 26 64" stroke="#5b21b6" stroke-width="4" fill="none" stroke-linecap="round"/>
</g>'''

SANS = "Inter, 'Segoe UI', Helvetica, Arial, 'DejaVu Sans', sans-serif"
MONO = "'SFMono-Regular', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

def banner():
    commits = "".join(
        f'<circle cx="{x}" cy="560" r="9" fill="{c}"/>' for x, c in
        [(120,"#a78bfa"),(250,"#a78bfa"),(380,"#f472b6"),(510,"#a78bfa"),(640,"#34d399"),(770,"#a78bfa"),(900,"#f472b6"),(1030,"#a78bfa"),(1160,"#34d399")])
    pills = ""
    for row, labels in enumerate([["semantic recall", "knowledge graph"], ["survives compaction", "~790 tokens / turn"]]):
        x = 562
        for label in labels:
            w = 28 + len(label) * 9.6
            y = 412 + row * 52
            pills += f'<rect x="{x}" y="{y}" width="{w}" height="40" rx="20" fill="#1e1b4b" stroke="#6d28d9"/><text x="{x + w/2}" y="{y + 26}" text-anchor="middle" font-family="{SANS}" font-size="17" fill="#ddd6fe">{label}</text>'
            x += w + 12
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f0a24"/><stop offset="1" stop-color="#1a1040"/></linearGradient>
    <radialGradient id="glow" cx="0.27" cy="0.45" r="0.35"><stop offset="0" stop-color="#7c3aed" stop-opacity="0.45"/><stop offset="1" stop-color="#7c3aed" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <rect width="1280" height="640" fill="url(#glow)"/>
  <defs>{HIPPO}</defs>
  <use href="#hippo" transform="translate(330 280) scale(1.75)"/>
  <text x="560" y="250" font-family="{SANS}" font-size="104" font-weight="800" fill="#f5f3ff" letter-spacing="-3">githippo</text>
  <text x="564" y="318" font-family="{SANS}" font-size="34" fill="#c4b5fd">A hippocampus for your AI.</text>
  <text x="564" y="356" font-family="{SANS}" font-size="21" fill="#a1a1aa">Long-term memory for Claude &amp; any MCP client,</text>
  <text x="564" y="384" font-family="{SANS}" font-size="21" fill="#a1a1aa">stored as Markdown in your own git repo.</text>
  {pills}
  <line x1="120" y1="560" x2="1160" y2="560" stroke="#4c1d95" stroke-width="4"/>
  {commits}
</svg>'''

def demo():
    W, H, DUR = 920, 470, 17.0
    lines = [
        (0.4, "#71717a", "● session · ~/code/johnny"),
        (1.2, "#f5f3ff", "› Use a 16 kHz sample rate. Sam owns the mic pipeline."),
        (2.4, "#34d399", "  ◆ remember → projects/johnny.md · linked: sam"),
        (3.4, "#a1a1aa", "  ✓ wake.ts · tasks: [x] detector  [~] mic stream  [ ] tests"),
        (4.8, "#fbbf24", "⚠ context window full → auto-compact"),
        (5.6, "#a78bfa", "  ◆ PreCompact · checkpoint saved from transcript (0 LLM tokens)"),
        (6.6, "#52525b", "  ─────────────── context compacted ───────────────"),
        (7.6, "#a78bfa", "  ◆ SessionStart · state restored · [~] Wire to mic stream"),
        (9.0, "#f5f3ff", "› what sample rate did we pick, and who owns it?"),
        (10.4, "#e4e4e7", "  16 kHz, and Sam owns the mic pipeline. Picking up where"),
        (10.8, "#e4e4e7", "  we stopped: wiring the mic stream into the detector."),
        (12.2, "#71717a", "  memory = Markdown in your private repo · every fact is a commit"),
    ]
    rows = []
    for i, (t, color, text) in enumerate(lines):
        k = t / DUR
        rows.append(
            f'<text x="28" y="{86 + i * 30}" fill="{color}" font-family="{MONO}" font-size="15.5" xml:space="preserve" opacity="0">'
            f'{html.escape(text)}'
            f'<animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;{k:.4f};{k + 0.012:.4f};0.95;1" dur="{DUR}s" repeatCount="indefinite"/></text>')
    cursor_y = 86 + len(lines) * 30
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
  <rect width="{W}" height="{H}" rx="14" fill="#0f0a24"/>
  <rect width="{W}" height="40" rx="14" fill="#1e1b4b"/><rect y="26" width="{W}" height="14" fill="#1e1b4b"/>
  <circle cx="24" cy="20" r="7" fill="#f87171"/><circle cx="46" cy="20" r="7" fill="#fbbf24"/><circle cx="68" cy="20" r="7" fill="#34d399"/>
  <text x="{W/2}" y="26" text-anchor="middle" fill="#a1a1aa" font-family="{MONO}" font-size="13">claude code + githippo</text>
  {"".join(rows)}
  <rect x="28" y="{cursor_y - 16}" width="10" height="20" fill="#a78bfa"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>
</svg>'''

open("banner.svg", "w").write(banner())
open("demo.svg", "w").write(demo())
import cairosvg, re
cairosvg.svg2png(url="banner.svg", write_to="social-preview.png", output_width=1280, output_height=640)
static = re.sub(r' opacity="0"', "", re.sub(r"<animate[^>]*/>", "", demo()))
cairosvg.svg2png(bytestring=static.encode(), write_to="/tmp/demo-check.png")
print("ok")
