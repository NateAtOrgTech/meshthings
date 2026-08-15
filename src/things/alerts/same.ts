// Parsing for NOAA Weather Radio's SAME headers -- the digital burst that
// precedes the voice message. The header is all we get: it carries what kind of
// alert it is, where, and for how long, but never the words being spoken.
//
//   ZCZC-WXR-TOR-023005-023031+0100-1232115-KGYX/NWS-
//        |   |   |             |    |       |
//        |   |   |             |    |       originating station
//        |   |   |             |    issued: day-of-year 123, 21:15 UTC
//        |   |   |             valid for 1h 00m
//        |   |   one or more PSSCCC areas
//        |   event code
//        originator

const SAME_PATTERN = /ZCZC-([A-Z]{3})-([A-Z]{3})((?:-\d{6})+)\+(\d{4})-(\d{7})-([^-]*)/;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Not exhaustive -- unknown codes fall back to the raw three letters rather
// than being dropped, since an unrecognised warning is still a warning
const EVENT_NAMES: Record<string, string> = {
  ADR: "Administrative Message",
  BZW: "Blizzard Warning",
  CAE: "Child Abduction Emergency",
  CDW: "Civil Danger Warning",
  CEM: "Civil Emergency",
  DMO: "Practice Demo",
  EAN: "Emergency Action Notification",
  EQW: "Earthquake Warning",
  EVI: "Evacuation Immediate",
  EWW: "Extreme Wind Warning",
  FFA: "Flash Flood Watch",
  FFS: "Flash Flood Statement",
  FFW: "Flash Flood Warning",
  FLA: "Flood Watch",
  FLW: "Flood Warning",
  FRW: "Fire Warning",
  HMW: "Hazardous Materials Warning",
  HUW: "Hurricane Warning",
  HWW: "High Wind Warning",
  LEW: "Law Enforcement Warning",
  NPT: "National Periodic Test",
  NUW: "Nuclear Power Plant Warning",
  RHW: "Radiological Hazard Warning",
  RMT: "Required Monthly Test",
  RWT: "Required Weekly Test",
  SMW: "Special Marine Warning",
  SPS: "Special Weather Statement",
  SPW: "Shelter In Place Warning",
  SVA: "Severe Thunderstorm Watch",
  SVR: "Severe Thunderstorm Warning",
  SVS: "Severe Weather Statement",
  TOA: "Tornado Watch",
  TOR: "Tornado Warning",
  TRW: "Tropical Storm Warning",
  TSA: "Tsunami Watch",
  TSW: "Tsunami Warning",
  WSW: "Winter Storm Warning",
};

// Tests are transmitted on a schedule. They must never reach the mesh, or people
// learn to ignore the channel -- but they are proof the receiver still works.
const TEST_EVENTS = new Set(["RWT", "RMT", "NPT", "DMO"]);

// Life-safety events jump the outbound queue; watches and statements do not
const IMMEDIATE_EVENTS = new Set([
  "CDW",
  "CEM",
  "EAN",
  "EQW",
  "EVI",
  "EWW",
  "FFW",
  "FRW",
  "HMW",
  "HUW",
  "NUW",
  "RHW",
  "SPW",
  "SVR",
  "TOR",
  "TSW",
]);

type SameMessage = {
  // WXR for weather radio, CIV/EAS/PEP for civil authorities
  originator: string;
  event: string;
  eventName: string;
  // Raw PSSCCC codes as transmitted
  areas: string[];
  issuedAt: number;
  expiresAt: number;
  station: string;
  isTest: boolean;
  isImmediate: boolean;
  // Identifies this alert across its three repeated bursts
  key: string;
  raw: string;
};

function eventName(event: string) {
  return EVENT_NAMES[event] ?? event;
}

// Purge time is +TTTT: hours and minutes the alert stays valid
function parsePurge(purge: string) {
  return (Number(purge.slice(0, 2)) * 60 + Number(purge.slice(2, 4))) * 60 * 1000;
}

// JJJHHMM: day of the year plus UTC time. There is no year in the header, so
// take it from the clock and step back if that lands in the future -- which is
// what a New Year's Eve alert read on January 1st would do.
function parseIssued(stamp: string, now: number) {
  const dayOfYear = Number(stamp.slice(0, 3));
  const hours = Number(stamp.slice(3, 5));
  const minutes = Number(stamp.slice(5, 7));

  if (dayOfYear < 1 || dayOfYear > 366 || hours > 23 || minutes > 59) {
    return undefined;
  }

  const year = new Date(now).getUTCFullYear();

  const at = (candidateYear: number) =>
    Date.UTC(candidateYear, 0, 1) + (dayOfYear - 1) * MILLISECONDS_PER_DAY + hours * 3600000 + minutes * 60000;

  const issued = at(year);

  // Allow a little slack for clock skew before deciding it must be last year
  return issued > now + MILLISECONDS_PER_DAY ? at(year - 1) : issued;
}

// Returns undefined for anything that is not a SAME header -- end-of-message
// markers, decoder chatter, partial bursts
function parseSame(line: string, now = Date.now()): SameMessage | undefined {
  const match = SAME_PATTERN.exec(line);

  if (!match) {
    return undefined;
  }

  const [raw, originator, event, areaBlock, purge, stamp, station] = match;
  const issuedAt = parseIssued(stamp, now);

  if (issuedAt === undefined) {
    return undefined;
  }

  const areas = areaBlock.split("-").filter((code) => code.length === 6);

  return {
    originator,
    event,
    eventName: eventName(event),
    areas,
    issuedAt,
    expiresAt: issuedAt + parsePurge(purge),
    station: station.trim(),
    isTest: TEST_EVENTS.has(event),
    isImmediate: IMMEDIATE_EVENTS.has(event),
    // The same alert is transmitted three times; everything identifying it is
    // in these fields, so all three bursts collapse to one key
    key: `${originator}-${event}-${areas.join(",")}-${stamp}`,
    raw,
  };
}

// SAME area codes are PSSCCC, where P marks part of a county. Subscribers care
// about the county, so match on SSCCC and ignore the part digit.
function areaMatches(alertAreas: string[], wanted: string[]) {
  const county = (code: string) => code.slice(-5);
  const wantedCounties = new Set(wanted.map(county));

  return alertAreas.some((area) => wantedCounties.has(county(area)));
}

export type { SameMessage };

export { parseSame, areaMatches, eventName, EVENT_NAMES, TEST_EVENTS, IMMEDIATE_EVENTS };
