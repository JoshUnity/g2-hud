import { describe, expect, it } from "vitest";
import { NDW_URL, NdwParser, inNetherlands, itemsNear, ndw, noIncidents, unescapeXml } from "../server/open/incidents";
import { fakeFetch, fixture, gz, ok, status } from "./openkit";

const NOW = Date.parse("2026-11-25T22:00:00Z");
const xml = fixture("ndw.xml");
const parse = (text: string, pos: { lat: number; lon: number }, keepM = 8000, now = NOW, chunk = 1 << 20) => {
  const p = new NdwParser({ pos, now, keepM });
  const buf = Buffer.from(text);
  for (let i = 0; i < buf.length; i += chunk) p.push(buf.subarray(i, i + chunk));
  return p;
};

/** One situation with one record, in the shape NDW sends. */
const situation = (type: string, body: string, opts: { overall?: string; start?: string; end?: string; at?: [number, number]; id?: string; status?: string } = {}) => `<sit:situation id="S"><sit:overallSeverity>${opts.overall ?? "medium"}</sit:overallSeverity><sit:headerInformation><com:informationStatus>${opts.status ?? "real"}</com:informationStatus></sit:headerInformation><sit:situationRecord xsi:type="sit:${type}" id="${opts.id ?? "R1"}" version="1"><sit:probabilityOfOccurrence>certain</sit:probabilityOfOccurrence><sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>${opts.start ?? "2026-11-25T10:00:00Z"}</com:overallStartTime>${opts.end ? `<com:overallEndTime>${opts.end}</com:overallEndTime>` : ""}</com:validityTimeSpecification></sit:validity>${body}<sit:locationReference xsi:type="loc:PointLocation"><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>${(opts.at ?? [52.37, 4.9])[0]}</loc:latitude><loc:longitude>${(opts.at ?? [52.37, 4.9])[1]}</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></sit:locationReference></sit:situationRecord></sit:situation>`;
const doc = (...s: string[]) => `<?xml version="1.0"?><mc:messageContainer><mc:payload>${s.join("")}</mc:payload></mc:messageContainer>`;
const HERE = { lat: 52.37, lon: 4.9 };
const one = (type: string, body: string, opts = {}) => parse(doc(situation(type, body, opts)), HERE).items[0];

describe("NDW DATEX II", () => {
  it("reads the recorded file: accident, closures, obstructions; no speed, bridge or shoulder records", () => {
    const p = parse(xml, { lat: 52, lon: 5 }, 1e7);
    expect(p.items.map((i) => [i.kind, i.severity, i.title])).toEqual([
      ["collision", 3, "Accident"],
      ["breakdown", 1, "Broken-down vehicle"],
      ["roadworks", 2, "Road closed for roadworks"],
      ["closure", 2, "Road closed"],
      ["obstruction", 2, "Object on the road"],
    ]);
  });

  it("gives a point record its position and a linear record its nearest point and its line", () => {
    const items = parse(xml, { lat: 52, lon: 5 }, 1e7).items;
    expect(items[0]).toMatchObject({ id: expect.stringMatching(/^ndw:/), lat: 51.53806, lon: 5.047521, area: null, lines: [] });
    const line = items.find((i) => i.kind === "roadworks")!;
    expect(line.lines).toHaveLength(1);
    expect(line.lines[0]!.length).toBeGreaterThanOrEqual(2);
    expect(line.lines[0]![0]).toEqual([51.814385, 4.609521]);
    expect(line.lat).toBe(51.814266);
  });

  it("keeps only items within the radius", () => {
    const near = { lat: 51.53806 + 0.003, lon: 5.047521 };
    expect(parse(xml, near, 500).items.map((i) => i.title)).toEqual(["Accident"]);
    expect(parse(xml, { lat: 51.53806 + 0.03, lon: 5.047521 }, 500).items).toEqual([]);
    expect(parse(xml, { lat: 51.53806 + 0.03, lon: 5.047521 }, 4000).items).toHaveLength(1);
  });

  it("measures a line by its nearest point, not its first one", () => {
    // The closure line ends at 51.814266, 4.610842. Stand 300 m past that end.
    const p = parse(xml, { lat: 51.814266 + 0.0027, lon: 4.610842 }, 500);
    expect(p.items.map((i) => i.title)).toEqual(["Road closed for roadworks"]);
  });

  it("gives the same answer when the file arrives in tiny pieces", () => {
    const whole = parse(xml, { lat: 52, lon: 5 }, 1e7).items;
    expect(parse(xml, { lat: 52, lon: 5 }, 1e7, NOW, 97).items).toEqual(whole);
    expect(parse(xml, { lat: 52, lon: 5 }, 1e7, NOW, 1).items).toEqual(whole);
  });

  it("leaves out ended and not-yet-started records, test data, and unlikely events", () => {
    const rec = (opts: object) => parse(doc(situation("Accident", "", opts)), HERE).items.length;
    expect(rec({})).toBe(1);
    expect(rec({ end: "2026-11-25T21:00:00Z" })).toBe(0);
    expect(rec({ end: "2026-11-25T23:00:00Z" })).toBe(1);
    expect(rec({ start: "2026-11-25T23:00:00Z" })).toBe(0);
    expect(rec({ status: "test" })).toBe(0);
    expect(parse(doc(situation("Accident", "").replace("certain", "riskOf")), HERE).items).toEqual([]);
  });

  it("drops a record with no coordinates and counts it", () => {
    const text = doc(situation("Accident", "").replace(/<sit:locationReference[\s\S]*<\/sit:locationReference>/, ""));
    const p = parse(text, HERE);
    expect(p.items).toEqual([]);
    expect(p.dropped).toBe(1);
  });

  it("reads each situation by itself: a bad one does not cost the next", () => {
    const bad = situation("Accident", "", { id: "BAD", at: [Number.NaN, 4.9] });
    const p = parse(doc(bad, situation("Accident", "", { id: "GOOD" })), HERE);
    expect(p.items.map((i) => i.id)).toEqual(["ndw:GOOD"]);
  });

  it("does not list one record twice", () => {
    expect(parse(doc(situation("Accident", ""), situation("Accident", "")), HERE).items).toHaveLength(1);
  });

  it("severity: accident 3; closed road 2; lane 1; high situation adds 1 up to 3", () => {
    const works = "<sit:cause><sit:causeType>roadMaintenance</sit:causeType></sit:cause>";
    const mgmt = (t: string, extra = "") => `${extra}<sit:roadOrCarriagewayOrLaneManagementType>${t}</sit:roadOrCarriagewayOrLaneManagementType>`;
    const R = "RoadOrCarriagewayOrLaneManagement";
    expect(one("Accident", "", { overall: "lowest" })).toMatchObject({ kind: "collision", severity: 3 });
    expect(one(R, mgmt("carriagewayClosures", works))).toMatchObject({ kind: "roadworks", severity: 2, title: "Road closed for roadworks" });
    expect(one(R, mgmt("carriagewayClosures"))).toMatchObject({ kind: "closure", severity: 2, title: "Road closed" });
    expect(one(R, mgmt("roadClosed"), { overall: "high" })).toMatchObject({ severity: 3 });
    expect(one(R, mgmt("roadClosed"), { overall: "low" })).toMatchObject({ severity: 2 });
    expect(one(R, mgmt("laneClosures", works))).toMatchObject({ kind: "roadworks", severity: 1, title: "Lane closed for roadworks" });
    expect(one(R, mgmt("laneClosures"), { overall: "highest" })).toMatchObject({ kind: "lanes", severity: 2, title: "Lane closed" });
    expect(one(R, mgmt("narrowLanes", works))).toMatchObject({ kind: "roadworks", severity: 1, title: "Roadworks" });
    expect(one("VehicleObstruction", "<sit:vehicleObstructionType>brokenDownVehicle</sit:vehicleObstructionType>")).toMatchObject({ kind: "breakdown", severity: 1 });
    expect(one("GeneralObstruction", "<sit:obstructionType>objectOnTheRoad</sit:obstructionType>")).toMatchObject({ severity: 2 });
  });

  it("skips records that are not incidents", () => {
    const R = "RoadOrCarriagewayOrLaneManagement";
    expect(one("SpeedManagement", "")).toBeUndefined();
    expect(one("ReroutingManagement", "")).toBeUndefined();
    expect(one("GeneralNetworkManagement", "")).toBeUndefined();
    expect(one(R, "<sit:roadOrCarriagewayOrLaneManagementType>hardShoulderRunningInOperation</sit:roadOrCarriagewayOrLaneManagementType>")).toBeUndefined();
    expect(one(R, "<sit:roadOrCarriagewayOrLaneManagementType>other</sit:roadOrCarriagewayOrLaneManagementType>")).toBeUndefined();
  });

  it("stops on a file that is far too large", () => {
    const p = new NdwParser({ pos: HERE, now: NOW, keepM: 1 });
    const big = Buffer.alloc(16 * 1024 * 1024, "a");
    expect(() => {
      for (let i = 0; i < 6; i++) p.push(big);
    }).toThrow("too large");
  });

  it("reads XML entities", () => {
    expect(unescapeXml("A &amp; B &lt;1&gt; &#233; &#x41; &bogus;")).toBe("A & B <1> é A &bogus;");
  });
});

describe("the NDW provider", () => {
  it("downloads the gzipped file, parses it as a stream, and sends the User-Agent", async () => {
    const f = fakeFetch(() => gz(xml));
    const items = await ndw(f).load({ lat: 51.54, lon: 5.05 }, NOW, 8000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(NDW_URL);
    expect(f.calls[0]!.url).toBe("https://opendata.ndw.nu/actueel_beeld.xml.gz");
    expect(f.calls[0]!.headers["User-Agent"]).toBe("g2-hud (open source)");
    expect(items.map((i) => i.title)).toEqual(["Accident"]);
  });

  it("fails on an HTTP error and on a body that is not gzip", async () => {
    await expect(ndw(fakeFetch(() => status(503))).load(HERE, NOW, 8000)).rejects.toThrow("503");
    await expect(ndw(fakeFetch(() => ok("<xml/>"))).load(HERE, NOW, 8000)).rejects.toThrow();
  });

  it("covers the Netherlands only; downloads at most every 5 minutes", () => {
    const p = ndw(fakeFetch(() => ok("")));
    expect(p.minIntervalMs).toBe(300_000);
    expect(p.covers({ lat: 52.3791, lon: 4.9003 })).toBe(true);
    expect(p.covers({ lat: 51.9, lon: 4.5 })).toBe(true);
    expect(inNetherlands({ lat: 48.85, lon: 2.35 })).toBe(false);
    expect(inNetherlands({ lat: 47.2, lon: -31.4 })).toBe(false);
  });

  it("the empty provider covers nothing", async () => {
    expect(noIncidents.covers(HERE)).toBe(false);
    expect(await noIncidents.load(HERE, NOW, 1)).toEqual([]);
  });
});

describe("itemsNear", () => {
  it("keeps items within the radius, most severe then nearest first", () => {
    const item = (id: string, severity: number, dLat: number) => ({ id, kind: "k", severity, title: id, lat: 52 + dLat, lon: 5, area: null, lines: [] });
    const out = itemsNear([item("far", 3, 0.05), item("b", 1, 0.01), item("a", 1, 0.005), item("c", 2, 0.02)], { lat: 52, lon: 5 }, 3000);
    expect(out.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });
});
