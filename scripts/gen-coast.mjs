// Generates src/data/coastlines.json: outer boundary rings as [lon,lat] pairs,
// decoded from the bundled world-atlas TopoJSON (Natural Earth 110m).
// Used by scripts/og.html to draw the OG image globe.
import { feature } from "topojson-client";
import { readFileSync, writeFileSync } from "node:fs";

const topo = JSON.parse(
  readFileSync(new URL("../src/data/countries-110m.json", import.meta.url)),
);
const fc = feature(topo, topo.objects.countries);
const rings = [];
for (const f of fc.features) {
  const polys =
    f.geometry.type === "Polygon"
      ? [f.geometry.coordinates]
      : f.geometry.coordinates;
  for (const p of polys) {
    if (p[0].length > 2) rings.push(p[0]);
  }
}
writeFileSync(
  new URL("../src/data/coastlines.json", import.meta.url),
  JSON.stringify(rings),
);
console.log(`wrote ${rings.length} coastline rings`);
