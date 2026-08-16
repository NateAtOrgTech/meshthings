// Formatting for a medium with a hard byte budget. Pure functions, no radio
// involved -- meshthings need these as much as the core does, which is why
// they do not live in the module host.

// A meshtastic text payload tops out around 200 bytes. Stay under it with room
// for the radio's own overhead.
const MAX_TEXT_BYTES = 180;

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf8");
}

const ELLIPSIS = "…";

// Clamp on a character boundary so we never emit a split codepoint. The budget
// covers the ellipsis too -- it is three bytes in UTF-8, not one.
function truncateBytes(text: string, budget: number) {
  if (byteLength(text) <= budget) {
    return text;
  }

  const allowance = budget - byteLength(ELLIPSIS);
  let result = "";

  for (const character of text) {
    if (byteLength(result + character) > allowance) {
      break;
    }
    result += character;
  }

  return result + ELLIPSIS;
}

// Pack lines into whichever page was asked for. Any listing longer than a
// couple of entries outgrows a single packet, so this is shared rather than
// reimplemented per module.
// moreCommand is what the reader sends to get the next page. Omit it when there
// is no such command -- a footer naming one that does something else is worse
// than no footer at all.
function paginate(lines: string[], page: number, moreCommand?: string, budget = MAX_TEXT_BYTES) {
  if (lines.length === 0) {
    return "";
  }

  const perPage = budget - 28; // reserve room for the "(1/3) more" footer
  // A line longer than a whole page would otherwise be emitted intact, pushing
  // the page past the byte limit -- and what send() then truncates is the tail,
  // which is the footer telling the reader there are more pages at all.
  const clamped = lines.map((line) => truncateBytes(line, perPage));
  const pages: string[][] = [];
  let current: string[] = [];
  let size = 0;

  clamped.forEach((line) => {
    const cost = byteLength(line) + 1; // newline

    if (current.length > 0 && size + cost > perPage) {
      pages.push(current);
      current = [];
      size = 0;
    }

    current.push(line);
    size += cost;
  });

  if (current.length > 0) {
    pages.push(current);
  }

  const index = Math.min(Math.max(page, 1), pages.length) - 1;
  const body = pages[index].join("\n");

  if (pages.length === 1) {
    return body;
  }

  const next = moreCommand && index + 2 <= pages.length ? ` ${moreCommand} ${index + 2}` : "";

  return `${body}\n(${index + 1}/${pages.length})${next}`;
}

function parsePage(args: string[]) {
  const page = Number.parseInt(args[0] ?? "1", 10);

  return Number.isFinite(page) ? page : 1;
}

export { byteLength, truncateBytes, paginate, parsePage, MAX_TEXT_BYTES };
