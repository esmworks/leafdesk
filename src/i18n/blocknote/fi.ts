import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Finnish dictionary; translations of the editor's own UI live here.

/**
 * Slash-menu search terms: BlockNote's English aliases plus Finnish ones, with and without
 * Finnish characters, so typing "otsikko", "lainaus" or "tehtava" finds the item.
 */
function finnishAliases(english: string[], finnish: string[]): string[] {
  return [...english, ...finnish];
}

export const fi: Dictionary = {
  slash_menu: {
    heading: {
      title: "Otsikko 1",
      subtext: "Ylimmän tason otsikko",
      aliases: finnishAliases(["h", "heading1", "h1"], ["otsikko", "otsikko1", "pääotsikko", "paaotsikko"]),
      group: "Otsikot",
    },
    heading_2: {
      title: "Otsikko 2",
      subtext: "Pääosion otsikko",
      aliases: finnishAliases(["h2", "heading2", "subheading"], ["otsikko2", "väliotsikko", "valiotsikko"]),
      group: "Otsikot",
    },
    heading_3: {
      title: "Otsikko 3",
      subtext: "Alaosion ja ryhmän otsikko",
      aliases: finnishAliases(["h3", "heading3", "subheading"], ["otsikko3", "väliotsikko", "valiotsikko"]),
      group: "Otsikot",
    },
    heading_4: {
      title: "Otsikko 4",
      subtext: "Pienen alaosion otsikko",
      aliases: finnishAliases(["h4", "heading4", "subheading4"], ["otsikko4", "väliotsikko", "valiotsikko"]),
      group: "Alaotsikot",
    },
    heading_5: {
      title: "Otsikko 5",
      subtext: "Pienen alaosion otsikko",
      aliases: finnishAliases(["h5", "heading5", "subheading5"], ["otsikko5", "väliotsikko", "valiotsikko"]),
      group: "Alaotsikot",
    },
    heading_6: {
      title: "Otsikko 6",
      subtext: "Alimman tason otsikko",
      aliases: finnishAliases(["h6", "heading6", "subheading6"], ["otsikko6", "väliotsikko", "valiotsikko"]),
      group: "Alaotsikot",
    },
    toggle_heading: {
      title: "Avattava otsikko 1",
      subtext: "Ylimmän tason otsikko, joka avautuu ja sulkeutuu",
      aliases: finnishAliases(["h", "heading1", "h1", "collapsable"], ["otsikko", "avattava", "kokoontaitettava"]),
      group: "Alaotsikot",
    },
    toggle_heading_2: {
      title: "Avattava otsikko 2",
      subtext: "Pääosion otsikko, joka avautuu ja sulkeutuu",
      aliases: finnishAliases(["h2", "heading2", "subheading", "collapsable"], ["otsikko2", "avattava", "kokoontaitettava"]),
      group: "Alaotsikot",
    },
    toggle_heading_3: {
      title: "Avattava otsikko 3",
      subtext: "Alaosion ja ryhmän otsikko, joka avautuu ja sulkeutuu",
      aliases: finnishAliases(["h3", "heading3", "subheading", "collapsable"], ["otsikko3", "avattava", "kokoontaitettava"]),
      group: "Alaotsikot",
    },
    quote: {
      title: "Lainaus",
      subtext: "Lainaus tai ote",
      aliases: finnishAliases(["quotation", "blockquote", "bq"], ["quote", "lainaus", "sitaatti"]),
      group: "Peruslohkot",
    },
    toggle_list: {
      title: "Avattava luettelo",
      subtext: "Luettelo, jonka alakohdat voi piilottaa",
      aliases: finnishAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["luettelo", "lista", "avattava luettelo", "avattava lista"]),
      group: "Peruslohkot",
    },
    numbered_list: {
      title: "Numeroitu luettelo",
      subtext: "Luettelo järjestetyistä kohdista",
      aliases: finnishAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["luettelo", "lista", "numeroitu luettelo", "numeroitu lista"]),
      group: "Peruslohkot",
    },
    bullet_list: {
      title: "Luettelo",
      subtext: "Luettelo järjestämättömistä kohdista",
      aliases: finnishAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["luettelo", "lista", "luettelomerkit", "ranskalaiset viivat"]),
      group: "Peruslohkot",
    },
    check_list: {
      title: "Tarkistuslista",
      subtext: "Luettelo valintaruuduilla",
      aliases: finnishAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["tarkistuslista", "tehtävälista", "tehtavalista", "tehtävä", "tehtava", "valintaruutu"]),
      group: "Peruslohkot",
    },
    paragraph: {
      title: "Kappale",
      subtext: "Dokumentin leipäteksti",
      aliases: finnishAliases(["p", "paragraph"], ["kappale", "teksti"]),
      group: "Peruslohkot",
    },
    code_block: {
      title: "Koodilohko",
      subtext: "Koodilohko syntaksikorostuksella",
      aliases: finnishAliases(["code", "pre"], ["koodi", "koodilohko"]),
      group: "Peruslohkot",
    },
    page_break: {
      title: "Sivunvaihto",
      subtext: "Sivun erotin",
      aliases: finnishAliases(["page", "break", "separator"], ["sivunvaihto", "erotin"]),
      group: "Peruslohkot",
    },
    table: {
      title: "Taulukko",
      subtext: "Taulukko muokattavilla soluilla",
      aliases: finnishAliases(["table"], ["taulukko"]),
      group: "Lisäasetukset",
    },
    image: {
      title: "Kuva",
      subtext: "Skaalattava kuva kuvatekstillä",
      aliases: finnishAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["kuva", "valokuva", "lataa", "media"]),
      group: "Media",
    },
    video: {
      title: "Video",
      subtext: "Skaalattava video kuvatekstillä",
      aliases: finnishAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["elokuva", "lataa"]),
      group: "Media",
    },
    audio: {
      title: "Ääni",
      subtext: "Upotettu ääni kuvatekstillä",
      aliases: finnishAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["ääni", "aani", "musiikki", "lataa"]),
      group: "Media",
    },
    file: {
      title: "Tiedosto",
      subtext: "Upotettu tiedosto",
      aliases: finnishAliases(["file", "upload", "embed", "media", "url"], ["tiedosto", "liite", "lataa", "upota"]),
      group: "Media",
    },
    emoji: {
      title: "Emoji",
      subtext: "Hae ja lisää emoji",
      aliases: finnishAliases(["emoji", "emote", "emotion", "face"], ["hymiö", "hymio", "kasvot"]),
      group: "Muut",
    },
    divider: {
      title: "Erotin",
      subtext: "Erota lohkot toisistaan visuaalisesti",
      aliases: finnishAliases(["divider", "hr", "line", "horizontal rule"], ["erotin", "viiva", "vaakaviiva"]),
      group: "Peruslohkot",
    },
  },
  placeholders: {
    default: "Kirjoita tekstiä tai ”/” komentoja varten",
    heading: "Otsikko",
    toggleListItem: "Avattava kohta",
    bulletListItem: "Luettelo",
    numberedListItem: "Luettelo",
    checkListItem: "Luettelo",
    emptyDocument: undefined,
    new_comment: "Kirjoita kommentti...",
    edit_comment: "Muokkaa kommenttia...",
    comment_reply: "Lisää kommentti...",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "Lisää kuva",
      video: "Lisää video",
      audio: "Lisää ääni",
      file: "Lisää tiedosto",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "Tyhjä avattava lohko. Lisää lohko napsauttamalla.",
  },
  code_block: {
    add_source_button_text: "Lisää lähdekoodi",
    ok_button_text: "OK",
  },
  // from react package:
  side_menu: {
    add_block_label: "Lisää lohko",
    drag_handle_label: "Avaa lohkovalikko",
  },
  drag_handle: {
    delete_menuitem: "Poista",
    colors_menuitem: "Värit",
    header_row_menuitem: "Otsikkorivi",
    header_column_menuitem: "Otsikkosarake",
  },
  table_handle: {
    delete_column_menuitem: "Poista sarake",
    delete_row_menuitem: "Poista rivi",
    add_left_menuitem: "Lisää sarake vasemmalle",
    add_right_menuitem: "Lisää sarake oikealle",
    add_above_menuitem: "Lisää rivi yläpuolelle",
    add_below_menuitem: "Lisää rivi alapuolelle",
    split_cell_menuitem: "Jaa solu",
    merge_cells_menuitem: "Yhdistä solut",
    background_color_menuitem: "Taustaväri",
  },
  suggestion_menu: {
    no_items_title: "Ei tuloksia",
  },
  color_picker: {
    text_title: "Teksti",
    background_title: "Tausta",
    colors: {
      default: "Automaattinen",
      gray: "Harmaa",
      brown: "Ruskea",
      red: "Punainen",
      orange: "Oranssi",
      yellow: "Keltainen",
      green: "Vihreä",
      blue: "Sininen",
      purple: "Violetti",
      pink: "Vaaleanpunainen",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "Lihavointi",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "Kursivointi",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "Alleviivaus",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "Yliviivaus",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "Koodi",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "Värit",
    },
    link: {
      tooltip: "Luo linkki",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "Muokkaa kuvatekstiä",
      input_placeholder: "Muokkaa kuvatekstiä",
    },
    file_replace: {
      tooltip: {
        image: "Vaihda kuva",
        video: "Vaihda video",
        audio: "Vaihda ääni",
        file: "Vaihda tiedosto",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "Nimeä kuva uudelleen",
        video: "Nimeä video uudelleen",
        audio: "Nimeä ääni uudelleen",
        file: "Nimeä tiedosto uudelleen",
      } as Record<string, string>,
      input_placeholder: {
        image: "Nimeä kuva uudelleen",
        video: "Nimeä video uudelleen",
        audio: "Nimeä ääni uudelleen",
        file: "Nimeä tiedosto uudelleen",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "Lataa kuva",
        video: "Lataa video",
        audio: "Lataa ääni",
        file: "Lataa tiedosto",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "Poista kuva",
        video: "Poista video",
        audio: "Poista ääni",
        file: "Poista tiedosto",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "Näytä tai piilota esikatselu",
    },
    nest: {
      tooltip: "Sisennä",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "Poista sisennys",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "Tasaa vasemmalle",
    },
    align_center: {
      tooltip: "Keskitä",
    },
    align_right: {
      tooltip: "Tasaa oikealle",
    },
    align_justify: {
      tooltip: "Tasaa molemmat reunat",
    },
    table_cell_merge: {
      tooltip: "Yhdistä solut",
    },
    comment: {
      tooltip: "Lisää kommentti",
    },
  },
  file_panel: {
    upload: {
      title: "Lähetä",
      file_placeholder: {
        image: "Lähetä kuva",
        video: "Lähetä video",
        audio: "Lähetä ääni",
        file: "Lähetä tiedosto",
      } as Record<string, string>,
      upload_error: "Virhe: lähetys epäonnistui",
    },
    embed: {
      title: "Upota",
      embed_button: {
        image: "Upota kuva",
        video: "Upota video",
        audio: "Upota ääni",
        file: "Upota tiedosto",
      } as Record<string, string>,
      url_placeholder: "Anna URL",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "Poista linkki",
    },
    edit: {
      text: "Muokkaa linkkiä",
      tooltip: "Muokkaa",
    },
    open: {
      tooltip: "Avaa uudessa välilehdessä",
    },
    form: {
      title_placeholder: "Muokkaa otsikkoa",
      url_placeholder: "Muokkaa URL-osoitetta",
    },
  },
  comments: {
    edited: "muokattu",
    save_button_text: "Tallenna",
    cancel_button_text: "Peruuta",
    deleted_reference_text: "Alkuperäinen sisältö poistettu",
    discard_pending_comment: "Haluatko varmasti hylätä tämän kommentin?",
    actions: {
      add_reaction: "Lisää reaktio",
      resolve: "Merkitse ratkaistuksi",
      reopen: "Avaa uudelleen",
      edit_comment: "Muokkaa kommenttia",
      delete_comment: "Poista kommentti",
      more_actions: "Lisää toimintoja",
    },
    reactions: {
      reacted_by: "Reagoineet",
    },
    sidebar: {
      marked_as_resolved: "Merkitty ratkaistuksi",
      more_replies: (count: number) => (count === 1 ? "1 vastaus lisää" : `${count} vastausta lisää`),
    },
  },
  suggestion_changes: {
    formatting_change: "Muotoilun muutos",
    deleted: "Poistettu",
    inserted_by: (users: string) => `Lisännyt: ${users}`,
    deleted_by: (users: string) => `Poistanut: ${users}`,
    formatting_change_by: (formats: string, users: string) => `Muotoilun muutos (${formats}), tehnyt: ${users}`,
  },
  exporter: {
    open_file: "Avaa tiedosto",
    open_video_file: "Avaa video",
    open_audio_file: "Avaa ääni",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "OK",
  },
};
