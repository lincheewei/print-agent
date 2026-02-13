import axios from "axios";

const API_URL =
  "http://10.0.100.15:51554/api/Production/UpdateListMaterialRelease";

// FULL component list
const components = [
  { JobId: 28304, Material: "E23-0112", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0101-23", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0101-24-C1", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0101-21", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0101-25", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0127", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0113", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0114-C1", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0116-C1", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0126", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0118-C1", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0124", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0125", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0111", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0104", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0103", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0101-22", UOM: "PCS", Qty: 100, Location: "P3-I" },
  { JobId: 28304, Material: "E16-0102-06", UOM: "PCS", Qty: 100, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0143-C0", UOM: "PCS", Qty: 50, Location: "P3-I" },
  { JobId: 28304, Material: "E23-0141", UOM: "PCS", Qty: 50, Location: "P3-I" }
];

// Small delay to avoid hammering MES
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function releaseComponentsSequentially() {
  for (const item of components) {
    console.log(
      `🚀 Releasing ${item.Material} | Qty: ${item.Qty}`
    );

    try {
      const resp = await axios.post(
        API_URL,
        [item], // 👈 API expects ARRAY
        {
          headers: { "Content-Type": "application/json" },
          timeout: 8000
        }
      );

      console.log(
        `✅ SUCCESS ${item.Material}:`,
        JSON.stringify(resp.data)
      );
    } catch (err) {
      console.error(
        `❌ FAILED ${item.Material}:`,
        err.response?.data || err.message
      );
    }

    // throttle
    await sleep(300);
  }

  console.log("🏁 All components processed");
}

releaseComponentsSequentially();