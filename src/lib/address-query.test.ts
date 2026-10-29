import { describe, expect, it } from "vitest";
import { addressQueries, isNamedPlace, matches } from "./address-query";

const queries = (text: string) => addressQueries(text).map((q) => q.query);

describe("address queries", () => {
  it("spells abbreviations out, leaves door, block and postcode numbers out, and narrows down to the area", () => {
    expect(addressQueries("Hacı İshak Mah. Yeni Sanayi Sitesi, No: 19 Blok No:13, 45200 Akhisar/Manisa, Türkiye")).toEqual([
      { query: "Hacı İshak Mah. Yeni Sanayi Sitesi, No: 19 Blok No:13, 45200 Akhisar/Manisa, Türkiye", within: [], names: [] },
      {
        query: "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar, Manisa, Türkiye",
        within: ["Akhisar", "Manisa"],
        names: ["haci", "ishak", "yeni", "sanayi"],
      },
      { query: "Yeni Sanayi Sitesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"], names: ["yeni", "sanayi"] },
      { query: "Hacı İshak Mahallesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"], names: ["haci", "ishak"] },
      { query: "Hacıishak Mahallesi, Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"], names: ["haciishak"] },
      { query: "Akhisar, Manisa, Türkiye", within: ["Akhisar", "Manisa"], names: [] },
    ]);
    expect(queries("Atatürk Cad. No:5, Konak/İzmir")).toEqual(["Atatürk Cad. No:5, Konak/İzmir", "Atatürk Caddesi, Konak, İzmir", "Konak, İzmir"]);
  });

  it("takes a district written first, before the details, as part of the area", () => {
    expect(addressQueries("Buca – Kozağaç Mah. 100. Sokak No:1 2, İzmir").slice(1)).toEqual([
      { query: "Kozağaç Mahallesi, 100 Sokak, Buca, İzmir", within: ["Buca", "İzmir"], names: ["kozagac", "100"] },
      { query: "100 Sokak, Buca, İzmir", within: ["Buca", "İzmir"], names: ["100"] },
      { query: "Kozağaç Mahallesi, Buca, İzmir", within: ["Buca", "İzmir"], names: ["kozagac"] },
      { query: "Buca, İzmir", within: ["Buca", "İzmir"], names: [] },
    ]);
    expect(queries("Akhisar – Hacı İshak Mah. Yeni Sanayi Sitesi").slice(1)).toEqual([
      "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar",
      "Yeni Sanayi Sitesi, Akhisar",
      "Hacı İshak Mahallesi, Akhisar",
      "Hacıishak Mahallesi, Akhisar",
      "Akhisar",
    ]);
  });

  it("leaves out notes in brackets, door letters, numbers without a label and directions", () => {
    expect(queries("Çiğli (şube Menemen) – Kapı No: 5 A, Ataşehir Mah. 8001 Sok. No:43, İzmir")[1]).toBe(
      "Ataşehir Mahallesi, 8001 Sokak, Çiğli, İzmir",
    );
    expect(queries("Bornova – Naldöken Mah. Ankara Cad. 359/K D:209, İzmir")[1]).toBe("Naldöken Mahallesi, Ankara Caddesi, Bornova, İzmir");
    expect(queries("Didim – Yeni Mah. 819 Sk. Kapı No: 5 A, Aydın")[1]).toBe("Yeni Mahallesi, 819 Sokak, Didim, Aydın");
    expect(queries("Afyonkarahisar – Kocatepe Mah. Adnan Menderes Bulvarı, Cezaevi Karşısı, Taşkın Apt. 43/1")[1]).toBe(
      "Kocatepe Mahallesi, Adnan Menderes Bulvarı, Taşkın Apartmanı, Afyonkarahisar",
    );
    expect(queries("Bornova – Doğanlar Mah. 1491. Sk. No:88/a Bornova/izmir, İzmir")[1]).toBe("Doğanlar Mahallesi, 1491 Sokak, Bornova, izmir");
  });

  it("keeps numbered streets apart from door numbers and postcodes", () => {
    expect(queries("Kazımdirik Mah. 372/12 Sk. No: 4/A Bornova/İzmir").slice(1)).toEqual([
      "Kazımdirik Mahallesi, 372/12 Sokak, Bornova, İzmir",
      "372/12 Sokak, Bornova, İzmir",
      "Kazımdirik Mahallesi, Bornova, İzmir",
      "Bornova, İzmir",
    ]);
    expect(queries("Atatürk OSB 10003 Sk. No:12 Çiğli/İzmir")[1]).toBe("Atatürk Organize Sanayi Bölgesi, 10003 Sokak, Çiğli, İzmir");
  });

  it("never searches a word for a kind of place on its own, as in an industrial zone's neighbourhood", () => {
    expect(addressQueries("Kemalpaşa – Kemalpaşa OSB Mah. 9. Sok. No:9, İzmir")[3]).toEqual({
      query: "Kemalpaşa OSB Mahallesi, Kemalpaşa, İzmir",
      within: ["Kemalpaşa", "İzmir"],
      names: ["kemalpasa", "osb"],
    });
    expect(queries("Pancar Organize Sanayi Bölgesi Mah. 5. Cad. No:1 Torbalı / İzmir").slice(1)).toEqual([
      "Pancar Organize Sanayi Bölgesi Mahallesi, 5 Caddesi, Torbalı, İzmir",
      "5 Caddesi, Torbalı, İzmir",
      "Pancar Organize Sanayi Bölgesi Mahallesi, Torbalı, İzmir",
      "Torbalı, İzmir",
    ]);
  });

  it("joins a neighbourhood's words, leaves names alone and stops at the limit with the area last", () => {
    expect(queries("Hacı İshak, Akhisar, Manisa")).toEqual(["Hacı İshak, Akhisar, Manisa", "Hacıishak, Akhisar, Manisa", "Akhisar, Manisa"]);
    expect(addressQueries("Moda Kadıköy")).toEqual([{ query: "Moda Kadıköy", within: [], names: [] }]);
    expect(queries("Akhisar")).toEqual(["Akhisar"]);
    expect(addressQueries("  ")).toEqual([]);
    expect(addressQueries("Hacı İshak Mah. Yeni Sanayi Sitesi, Akhisar/Manisa", 3).map((q) => q.query)).toEqual([
      "Hacı İshak Mah. Yeni Sanayi Sitesi, Akhisar/Manisa",
      "Hacı İshak Mahallesi, Yeni Sanayi Sitesi, Akhisar, Manisa",
      "Akhisar, Manisa",
    ]);
  });

  it("takes a found place only in the area and naming the street, without case or Turkish marks", () => {
    const street = { within: ["Bornova", "Izmir"], names: ["372/12"] };
    expect(matches("372/12. Sokak, Kazımdirik Mahallesi, Bornova, İzmir, Türkiye", street)).toBe(true);
    // Another number's street, or a building numbered like it, is not the street.
    expect(matches("8901. Sokak, Balatçık Mahallesi, Bornova, İzmir, Türkiye", street)).toBe(false);
    expect(matches("Hastane, 336/1, 372 Sokak, Bornova, İzmir, Türkiye", { within: ["Bornova"], names: ["1"] })).toBe(false);
    expect(matches("Yeni Sanayi Sitesi, Pamukova, Sakarya, Türkiye", { within: ["Akhisar"], names: ["yeni", "sanayi"] })).toBe(false);
    // Of two districts named, the place lies in one.
    expect(matches("Hürriyet Mahallesi, Bornova, İzmir", { within: ["Menderes", "Bornova", "İzmir"], names: [] })).toBe(true);
    expect(matches("Anything", { within: [], names: [] })).toBe(true);
  });

  it("tells the place asked for from what lies in it", () => {
    expect(isNamedPlace("Kozağaç Mahallesi, Buca, İzmir, Türkiye", "Kozağaç Mahallesi, Buca, İzmir")).toBe(true);
    expect(isNamedPlace("Kozağaç Taksi, 254. Sokak, Kozağaç Mahallesi, Buca", "Kozağaç Mahallesi, Buca, İzmir")).toBe(false);
    expect(isNamedPlace("İsmet İnönü-1 Caddesi, Tepebaşı", "İsmet İnönü 1 Caddesi, Tepebaşı, Eskişehir")).toBe(true);
  });
});
