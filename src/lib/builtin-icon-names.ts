/**
 * The built-in line icons a page, row, callout, button, teamspace, agent, view or property can take
 * instead of an emoji, in the order the icon picker shows them. Each is the name of a drawing in
 * lib/builtin-icons-data.ts (generated from these names by scripts/builtin-icons.ts), optionally
 * followed by `|` and an emoji that means the same: the picker's search also finds the icon by that
 * emoji's names in the interface language.
 */
const LIST = `
file|📄 file-text|📄 files folder|📁 folder-open|📂 archive|🗃️ book|📕 book-open|📖 notebook|📓 notebook-pen
library|📚 bookmark|🔖 clipboard|📋 clipboard-check clipboard-list sticky-note|🗒️ newspaper|📰 scroll|📜
paperclip|📎 pin|📌 map-pin|📍 tag|🏷️ tags inbox|📥 mail|✉️ mail-open send printer|🖨️ pen|🖊️ pencil|✏️
pen-tool highlighter|🖍️ eraser scissors|✂️ ruler|📏 calculator|🧮 briefcase|💼 presentation signature stamp
receipt|🧾 file-spreadsheet sheet table kanban list list-checks list-todo square-check|☑️ circle-check|✅
check|✔️ x|❌ circle-x plus|➕ minus|➖ chart-bar|📊 chart-column|📊 chart-line|📈 chart-pie trending-up|📈
trending-down|📉 activity gauge target|🎯 database|🗄️ server hard-drive cloud|☁️ cloud-upload cloud-download
download upload link|🔗 layers layout-dashboard layout-grid blocks|🧩 puzzle|🧩 boxes box|📦 package|📦
calendar|📅 calendar-days|📆 calendar-check calendar-clock clock|🕒 alarm-clock|⏰ timer|⏲️ hourglass|⌛
history watch|⌚ message-circle|💬 message-square|💬 messages-square megaphone|📣 bell|🔔 bell-ring
phone|📞 smartphone|📱 video|📹 mic|🎤 at-sign hash user|👤 users|👥 user-plus user-check contact
id-card|🪪 handshake|🤝 heart-handshake baby|👶 smile|🙂 laugh|😄 meh|😐 frown|🙁 angry|😠 thumbs-up|👍
thumbs-down|👎 hand|✋ heart|❤️ star|⭐ sparkles|✨ award|🏅 trophy|🏆 medal|🥇 crown|👑 gift|🎁
party-popper|🎉 cake|🎂 flag|🚩 code|💻 code-xml terminal bug|🐛 git-branch git-pull-request git-merge cpu
laptop|💻 monitor|🖥️ keyboard|⌨️ mouse|🖱️ wifi|📶 battery|🔋 plug|🔌 power settings|⚙️ sliders-horizontal|🎚️
wrench|🔧 hammer|🔨 bot|🤖 brain|🧠 lightbulb|💡 rocket|🚀 zap|⚡ flame|🔥 atom|⚛️ flask-conical|🧪
test-tube|🧪 microscope|🔬 telescope|🔭 dna|🧬 magnet|🧲 shield|🛡️ shield-check lock|🔒 lock-open|🔓 key|🔑
fingerprint-pattern eye|👁️ eye-off scan qr-code globe|🌐 earth|🌍 map|🗺️ compass|🧭 navigation route signpost|🪧
search|🔍 funnel refresh-cw|🔄 repeat|🔁 shuffle|🔀 infinity|♾️ circle-help|❓ info|ℹ️ triangle-alert|⚠️
circle-alert|❗ octagon-alert|🛑 ban|🚫 circle|⚪ square|⬜ triangle|🔺 hexagon diamond|🔷 shapes palette|🎨
brush|🖌️ paint-bucket image|🖼️ camera|📷 film|🎞️ clapperboard|🎬 music|🎵 headphones|🎧 radio|📻 tv|📺
gamepad-2|🎮 dices|🎲 shopping-cart|🛒 shopping-bag|🛍️ store|🏪 credit-card|💳 wallet|👛 banknote|💵
coins|🪙 piggy-bank|🐷 circle-dollar-sign|💲 dollar-sign|💲 euro|💶 percent landmark|🏛️ building|🏢
building-2|🏢 factory|🏭 warehouse house|🏠 hotel|🏨 school|🏫 hospital|🏥 church|⛪ tent|⛺ castle|🏰
car|🚗 bus|🚌 truck|🚚 bike|🚲 train-front|🚆 plane|✈️ ship|🚢 sailboat|⛵ fuel|⛽ traffic-cone|🚧
anchor|⚓ luggage|🧳 ticket|🎫 sun|☀️ moon|🌙 cloud-rain|🌧️ cloud-snow|🌨️ snowflake|❄️ umbrella|☂️ wind|🌬️
rainbow|🌈 thermometer|🌡️ droplet|💧 waves|🌊 mountain|⛰️ mountain-snow|🏔️ trees|🌳 tree-pine|🌲 leaf|🍃
sprout|🌱 flower|🌸 flower-2|🌼 clover|🍀 bird|🐦 cat|🐱 dog|🐶 fish|🐟 rabbit|🐰 turtle|🐢 squirrel|🐿️
snail|🐌 paw-print|🐾 feather|🪶 shell|🐚 coffee|☕ cup-soda|🥤 wine|🍷 beer|🍺 utensils|🍴 chef-hat
pizza|🍕 apple|🍎 cherry|🍒 grape|🍇 carrot|🥕 egg|🥚 croissant|🥐 sandwich|🥪 ice-cream-cone|🍦 cookie|🍪
candy|🍬 salad|🥗 soup|🍲 heart-pulse|💓 stethoscope|🩺 pill|💊 syringe|💉 dumbbell|🏋️ volleyball|🏐 goal|🥅
footprints|👣 accessibility|♿ glasses|👓 shirt|👕 graduation-cap|🎓 backpack|🎒 trash-2|🗑️ recycle|♻️
lamp sofa|🛋️ bed|🛏️ bath|🛁 door-open|🚪 construction|🚧 hard-hat|⛑️ axe|🪓 shovel tractor|🚜 gem|💎
life-buoy|🛟 siren|🚨 skull|💀 ghost|👻 quote type heading text align-left languages spell-check sigma pi
binary braces arrow-right|➡️ arrow-left|⬅️ arrow-up|⬆️ arrow-down|⬇️ undo-2 redo-2 move external-link
share-2 copy save|💾 badge-check circle-dot circle-play|▶️ circle-pause|⏸️ circle-stop|⏹️ square-pen
`;

const entries = LIST.trim()
  .split(/\s+/)
  .map((item) => item.split("|") as [string, string?]);

/** The built-in icons' names, in picker order. */
export const BUILTIN_ICON_NAMES: readonly string[] = entries.map(([name]) => name);

/** For the picker's search: an emoji meaning the same as the icon, when there is one. */
export const BUILTIN_ICON_EMOJI: ReadonlyMap<string, string> = new Map(entries.flatMap(([name, emoji]) => (emoji ? [[name, emoji] as const] : [])));

const NAMES = new Set(BUILTIN_ICON_NAMES);

export function isBuiltinIconName(name: string): boolean {
  return NAMES.has(name);
}
