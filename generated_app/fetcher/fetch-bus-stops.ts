/**
 * fetcher/fetch-bus-stops.ts — F-38
 *
 * Build-time Node script. Queries NJ Transit bus stops from the NJOGIS ArcGIS
 * FeatureServer, filters to Hoboken, deduplicates by stop ID, and writes
 * data/bus-stops.json.
 *
 * Data source: NJ Transit Bus Stops by Line (NJGIN Open Data)
 * https://njogis-newjersey.opendata.arcgis.com/datasets/fcb66a1ea358460bad1113e2d4ec2ec5_11
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BusStop } from "../shared/types";

// ArcGIS FeatureServer — layer 11 is "Bus Stops of NJ Transit by Line"
const FEATURE_SERVICE_URL =
  "https://services6.arcgis.com/M0t0HPE53pFK525U/arcgis/rest/services/NJ_Transit_Bus_Stops_by_Line/FeatureServer/11/query";

interface ArcGisFeature {
  properties: {
    STOP_NUM: string;
    DESCRIPTION_BSL: string;
    DLAT_GIS: number;
    DLONG_GIS: number;
  };
}

interface ArcGisGeoJson {
  features: ArcGisFeature[];
}

async function main(): Promise<void> {
  const params = new URLSearchParams({
    where: "MUNICIPALITY='HOBOKEN'",
    outFields: "STOP_NUM,DESCRIPTION_BSL,DLAT_GIS,DLONG_GIS",
    f: "geojson",
    resultRecordCount: "1000",
  });

  const url = `${FEATURE_SERVICE_URL}?${params.toString()}`;

  console.log("Fetching Hoboken bus stops from NJOGIS ArcGIS...");
  const response = await fetch(url, {
    headers: {
      "User-Agent": "hoboken-parking-app/1.0 (build-time bus-stop fetcher)",
    },
  });

  if (!response.ok) {
    throw new Error(`ArcGIS query failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as ArcGisGeoJson;

  if (!Array.isArray(data.features)) {
    throw new Error("Unexpected response format from ArcGIS");
  }

  // Deduplicate: same physical stop appears once per bus line served
  const seen = new Set<string>();
  const stops: BusStop[] = [];

  for (const feature of data.features) {
    const { STOP_NUM, DESCRIPTION_BSL, DLAT_GIS, DLONG_GIS } = feature.properties;
    if (seen.has(STOP_NUM)) continue;
    if (isNaN(DLAT_GIS) || isNaN(DLONG_GIS)) continue;
    seen.add(STOP_NUM);
    stops.push({
      id: STOP_NUM,
      name: DESCRIPTION_BSL,
      lat: DLAT_GIS,
      lng: DLONG_GIS,
    });
  }

  const outPath = join(process.cwd(), "data", "bus-stops.json");
  writeFileSync(outPath, JSON.stringify(stops, null, 2));
  console.log(`Wrote ${stops.length} bus stops to data/bus-stops.json`);
}

void main().catch((err: unknown) => {
  console.error("fetch-bus-stops failed:", err);
  process.exit(1);
});
