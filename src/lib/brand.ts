// Derive a "brand" label from a product name so the inventory can collapse by brand.
// Most listings start with the maker (e.g. "SPRO Cheburashka...", "Fjuka 2mm Pellets").
// A small alias map keeps known multi-word or oddly-cased brands tidy.
const ALIASES: Record<string, string> = {
  spro: "SPRO",
  fjuka: "Fjuka",
  mikado: "Mikado",
  korda: "Korda",
  drennan: "Drennan",
  guru: "Guru",
  preston: "Preston",
  nash: "Nash",
  fox: "Fox",
  dynamite: "Dynamite Baits",
  "sonu baits": "Sonu Baits",
  sonubaits: "Sonu Baits",
  ridgemonkey: "RidgeMonkey",
  gardner: "Gardner",
  avid: "Avid Carp",
};

export function brandOf(name: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "Other";
  const lower = trimmed.toLowerCase();
  for (const key of Object.keys(ALIASES)) {
    if (lower.startsWith(key)) return ALIASES[key];
  }
  const first = trimmed.split(/\s+/)[0];
  // Capitalise a plain lower-case first word
  return first.length <= 4 ? first.toUpperCase() : first.charAt(0).toUpperCase() + first.slice(1);
}
