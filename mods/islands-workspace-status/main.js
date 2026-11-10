import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, shared, readTextFile, home, exec } from "herdr";

// The islands' fill at the opacity in islands-workspace-chrome/settings.json (1 when unset).
const islandFill = (c) => {
  const o = shared("islands.opacity");
  if (typeof o !== "number" || o >= 1 || !/^#[0-9a-f]{6}$/i.test(c)) return c;
  return c + Math.round(Math.max(0, o) * 255).toString(16).padStart(2, "0");
};

// Claude/Codex quotas, as in neon-pro-hud: older than this, shown dimmed.
const STALE = 6 * 3600;
const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
function resetIn(at, nowSec) {
  if (!at) return null;
  const s = Math.max(0, at - nowSec);
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))}`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
}

export default class WorkspaceStatus extends View {
  // Claude and Codex quotas (as in neon-pro-hud) and a clock.
  init(_props, cx) {
    this.now = new Date();
    cx.timer.every(15000, (cx) => { this.now = new Date(); cx.notify(); });
    this.claude = null;
    this.codex = null;
    this.readClaude(cx);
    cx.timer.every(20000, (cx) => this.readClaude(cx));
    this.readCodex(cx);
    cx.timer.every(60000, (cx) => this.readCodex(cx));
  }

  // Claude's 5h/7d windows, written by ~/.claude/statusline-command.sh.
  readClaude(cx) {
    cx.spawn(async (cx) => {
      let q = null;
      try { q = JSON.parse(await readTextFile(`${home()}/.cache/herdr/claude-quota.json`)); } catch {}
      const key = JSON.stringify(q);
      if (key === this.claudeKey) return;
      this.claudeKey = key;
      this.claude = q;
      cx.notify();
    });
  }

  // The last rate-limit line of the most recent Codex sessions (last 8 days).
  readCodex(cx) {
    cx.spawn(async (cx) => {
      const script = `cd "$HOME/.codex/sessions" 2>/dev/null || exit 0
for f in $(find . -name 'rollout-*.jsonl' -mtime -8 2>/dev/null | xargs ls -t 2>/dev/null | head -15); do
  l=$(grep '"primary":{' "$f" | tail -1)
  [ -n "$l" ] && { printf '%s' "$l"; exit 0; }
done`;
      let r = null;
      try { r = await exec("sh", ["-c", script]); } catch { return; }
      let c = null;
      try {
        const line = JSON.parse(r.stdout.trim());
        const rl = line?.payload?.rate_limits;
        if (rl) c = { rl, updated: Math.floor(Date.parse(line.timestamp) / 1000) || null };
      } catch {}
      const key = JSON.stringify(c);
      if (key === this.codexKey) return;
      this.codexKey = key;
      this.codex = c;
      cx.notify();
    });
  }

  // "5h ▬▬▬▭ 90%": what's left in one window.
  meter(t, win, nowSec, stale) {
    if (win?.used == null) return null;
    const passed = win.resets_at && win.resets_at <= nowSec;
    const left = passed ? 100 : Math.max(0, Math.min(100, Math.round(100 - win.used)));
    const c = stale ? t.dim : left <= 10 ? t.blocked : left <= 30 ? "#ff9f0a" : t.accent;
    return h_flex().flex_none().gap(6).items_center()
      .child(div().text_color(t.dim).child(win.label))
      .child(div().w(30).h(5).rounded(3).bg(t.border)
        .child(div().h_full().rounded(3).bg(c).w(Math.max(left > 0 ? 3 : 0, (30 * left) / 100))))
      .child(div().whitespace_nowrap().text_color(stale ? t.dim : left <= 30 ? c : t.foreground).font_semibold().child(`${left}%`));
  }

  capsule(t, id, icon, title, windows, updated, notes = []) {
    const nowSec = Math.floor(Date.now() / 1000);
    const stale = !updated || nowSec - updated > STALE;
    const meters = windows.map((w) => this.meter(t, w, nowSec, stale)).filter(Boolean);
    if (!meters.length) return null;
    const tip = [
      `${title} · quota left`,
      ...windows.filter((w) => w.resets_at && w.used != null).map((w) => `${w.long} resets in ${resetIn(w.resets_at, nowSec)}`),
      ...notes,
      stale ? `Not updated recently: run ${title} to refresh` : null,
    ].filter(Boolean).join("\n");
    return h_flex().id(id).flex_none().gap(9).items_center().tooltip(tip)
      .child(icon.when(stale, (e) => e.opacity(0.45)))
      .children(meters);
  }

  claudeSeg(t) {
    const rl = this.claude?.rate_limits;
    if (!rl) return null;
    return this.capsule(t, "islands-claude", svg("icons/claude.svg").size(13).flex_none().text_color("#d97757"), "Claude", [
      { label: "5h", long: "5-hour window", used: rl.five_hour?.used_percentage, resets_at: rl.five_hour?.resets_at },
      { label: "7d", long: "Weekly window", used: rl.seven_day?.used_percentage, resets_at: rl.seven_day?.resets_at },
    ], this.claude.updated);
  }

  codexSeg(t) {
    const rl = this.codex?.rl;
    if (!rl) return null;
    const win = (w) => {
      if (!w) return null;
      const m = w.window_minutes ?? 0;
      const label = m >= 1440 ? `${Math.round(m / 1440)}d` : `${Math.round(m / 60)}h`;
      return { label, long: m >= 10080 ? "Weekly window" : `${label} window`, used: w.used_percent, resets_at: w.resets_at };
    };
    return this.capsule(t, "islands-codex", image("icons/codex.svg").size(13).flex_none().rounded(3), "Codex",
      [win(rl.primary), win(rl.secondary)].filter(Boolean), this.codex.updated,
      ["Shared with opencode (signed in with ChatGPT)", rl.plan_type ? `ChatGPT plan: ${rl.plan_type}` : null]);
  }

  sep(t) { return div().flex_none().w(1).h(12).bg(t.border); }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const n = (st) => list.filter(a => a.status === st).length;
    const working = n("working"), done = n("done"), blocked = n("blocked");
    const agentsText = list.length === 0 ? "No agents" : list.length === 1 ? "1 agent" : `${list.length} agents`;
    const d = this.now;
    const date = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const label = (icon, text, color) => h_flex().flex_none().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13).text_color(color)).child(text); // colored icon, muted text
    const count = (color, text) => h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(color)).child(div().text_color(color).child(text));
    const segs = [this.claudeSeg(t), this.codexSeg(t)].filter(Boolean);
    let right = h_flex().flex_none().gap(16).items_center();
    segs.forEach((seg) => { right = right.child(seg).child(this.sep(t)); });
    right = right.child(div().text_color(t.dim).child(date)).child(div().text_color(t.foreground).font_medium().child(clock));
    return h_flex().size_full().px(14).gap(16).items_center().rounded(11).overflow_hidden().bg(islandFill(t.chrome)).text_size(11.8).text_color(t.muted) // its own card, no divider
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer", t.working))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch, t.accent)))
      .child(this.sep(t))
      .child(h_flex().flex_none().gap(6).items_center().child(div().size(6).rounded(3).bg(list.length > 0 ? t.muted : t.dim)).child(agentsText))
      .when(working > 0, el => el.child(count(t.working, `${working} running`)))
      .when(done > 0, el => el.child(count(t.done, `${done} done`)))
      .when(blocked > 0, el => el.child(h_flex().flex_none().gap(6).items_center().px(8).h(18).rounded(9).bg(t.blocked + "1f")
        .child(div().size(6).rounded(3).bg(t.blocked).loop("opacity", { from: 0.35, to: 1, period: 900 }))
        .child(div().text_color(t.blocked).font_medium().child(`${blocked} need${blocked > 1 ? "" : "s"} you`))))
      .child(div().flex_1().min_w(0))
      .child(right);
  }
}
