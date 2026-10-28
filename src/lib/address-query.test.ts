import { describe, expect, it } from "vitest";
import { addressQueries, liesWithin } from "./address-query";

const queries = (text: string) => addressQueries(text).map((q) => q.query);

describe("address queries", () => {
  it("spells abbreviations out, leaves door, block and postcode numbers out, and narrows down to the area", () => {
    expect(addressQueries("Hacı İshak Mah. Yeni Sanayi Sitesi, No: 19 Blok No:13, 45200 Akhisar/Manisa, Türkiye")).toEqual([
      { query: "Hacı İshak Mah. Yeni Sanayi Sitesi, No: 19 Blok No:13, 45200 Akhisar/Manisa, Türkiye", within: [] },
      { query: "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"] },
      { query: "Yeni Sanayi Sitesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"] },
      { query: "Hacı İshak Mahallesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"] },
      { query: "Hacıishak Mahallesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"] },
      { query: "Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"] },
    ]);
    expect(queries("Atatürk Cad. No:5, Konak/İzmir")).toEqual(["Atatürk Cad. No:5, Konak/İzmir", "Atatürk Caddesi, Konak, İzmir", "Konak, İzmir"]);
  });

  it("keeps numbered streets and door numbers with a slash apart from district/province", () => {
    expect(queries("Kazımdirik Mah. 372/12 Sk. No: 4/A Bornova/İzmir").slice(1)).toEqual([
      "Kazımdirik Mahallesi, 372/12 Sokak, Bornova, İzmir",
      "372/12 Sokak, Bornova, İzmir",
      "Kazımdirik Mahallesi, Bornova, İzmir",
      "Bornova, İzmir",
    ]);
    expect(queries("Atatürk OSB 10003 Sk. No:12 Çiğli/İzmir")[1]).toBe("Atatürk Organize Sanayi Bölgesi, 10003 Sokak, Çiğli, İzmir");
  });

  it("reads an area written first and neighbourhoods without their word", () => {
    expect(queries("Akhisar – Hacı İshak Mah. Yeni Sanayi Sitesi").slice(1)).toEqual([
      "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar",
      "Yeni Sanayi Sitesi, Akhisar",
      "Hacı İshak Mahallesi, Akhisar",
      "Hacıishak Mahallesi, Akhisar",
      "Akhisar",
    ]);
    expect(queries("Hacı İshak, Akhisar, Manisa")).toEqual(["Hacı İshak, Akhisar, Manisa", "Hacıishak, Akhisar, Manisa", "Akhisar, Manisa"]);
  });

  it("leaves names and short searches as they are, and stops at the limit with the area last", () => {
    expect(addressQueries("Moda Kadıköy")).toEqual([{ query: "Moda Kadıköy", within: [] }]);
    expect(queries("Akhisar")).toEqual(["Akhisar"]);
    expect(addressQueries("  ")).toEqual([]);
    expect(queries("Hacı İshak Mah. Yeni Sanayi Sitesi, No: 19, Akhisar/Manisa").length).toBe(6);
    expect(addressQueries("Hacı İshak Mah. Yeni Sanayi Sitesi, Akhisar/Manisa", 3).map((q) => q.query)).toEqual([
      "Hacı İshak Mah. Yeni Sanayi Sitesi, Akhisar/Manisa",
      "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar, Manisa",
      "Akhisar, Manisa",
    ]);
  });

  it("checks a found address names the area, without case or Turkish marks", () => {
    expect(liesWithin("Hacıishak Mahallesi, Yenidoğan, Akhisar, Manisa, Ege Bölgesi, Türkiye", ["Akhisar", "Manisa"])).toBe(true);
    expect(liesWithin("372/12. Sokak, Bornova, İzmir, Türkiye", ["Bornova", "Izmir"])).toBe(true);
    expect(liesWithin("Yeni Sanayi Sitesi, Pamukova, Sakarya, Türkiye", ["Akhisar"])).toBe(false);
    expect(liesWithin("Anything", [])).toBe(true);
  });
});
