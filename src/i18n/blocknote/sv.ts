import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Swedish dictionary; translations of the editor's own UI live here.

/**
 * Slash-menu search terms: BlockNote's English aliases plus Swedish ones, with and without
 * Swedish characters, so typing "rubrik", "citat" or "uppgift" finds the item.
 */
function swedishAliases(english: string[], swedish: string[]): string[] {
  return [...english, ...swedish];
}

export const sv: Dictionary = {
  slash_menu: {
    heading: {
      title: "Rubrik 1",
      subtext: "Rubrik på högsta nivån",
      aliases: swedishAliases(["h", "heading1", "h1"], ["rubrik", "rubrik1", "huvudrubrik"]),
      group: "Rubriker",
    },
    heading_2: {
      title: "Rubrik 2",
      subtext: "Rubrik för huvudavsnitt",
      aliases: swedishAliases(["h2", "heading2", "subheading"], ["rubrik2", "underrubrik"]),
      group: "Rubriker",
    },
    heading_3: {
      title: "Rubrik 3",
      subtext: "Rubrik för underavsnitt och grupper",
      aliases: swedishAliases(["h3", "heading3", "subheading"], ["rubrik3", "underrubrik"]),
      group: "Rubriker",
    },
    heading_4: {
      title: "Rubrik 4",
      subtext: "Rubrik för mindre underavsnitt",
      aliases: swedishAliases(["h4", "heading4", "subheading4"], ["rubrik4", "underrubrik"]),
      group: "Underrubriker",
    },
    heading_5: {
      title: "Rubrik 5",
      subtext: "Rubrik för små underavsnitt",
      aliases: swedishAliases(["h5", "heading5", "subheading5"], ["rubrik5", "underrubrik"]),
      group: "Underrubriker",
    },
    heading_6: {
      title: "Rubrik 6",
      subtext: "Rubrik på lägsta nivån",
      aliases: swedishAliases(["h6", "heading6", "subheading6"], ["rubrik6", "underrubrik"]),
      group: "Underrubriker",
    },
    toggle_heading: {
      title: "Utfällbar rubrik 1",
      subtext: "Rubrik på högsta nivån som kan fällas ut och ihop",
      aliases: swedishAliases(["h", "heading1", "h1", "collapsable"], ["rubrik", "utfällbar", "utfallbar", "hopfällbar", "hopfallbar"]),
      group: "Underrubriker",
    },
    toggle_heading_2: {
      title: "Utfällbar rubrik 2",
      subtext: "Rubrik för huvudavsnitt som kan fällas ut och ihop",
      aliases: swedishAliases(["h2", "heading2", "subheading", "collapsable"], ["rubrik2", "utfällbar", "utfallbar", "hopfällbar", "hopfallbar"]),
      group: "Underrubriker",
    },
    toggle_heading_3: {
      title: "Utfällbar rubrik 3",
      subtext: "Rubrik för underavsnitt och grupper som kan fällas ut och ihop",
      aliases: swedishAliases(["h3", "heading3", "subheading", "collapsable"], ["rubrik3", "utfällbar", "utfallbar", "hopfällbar", "hopfallbar"]),
      group: "Underrubriker",
    },
    quote: {
      title: "Citat",
      subtext: "Citat eller utdrag",
      aliases: swedishAliases(["quotation", "blockquote", "bq"], ["quote", "citat", "utdrag"]),
      group: "Grundblock",
    },
    toggle_list: {
      title: "Utfällbar lista",
      subtext: "Lista med underpunkter som kan döljas",
      aliases: swedishAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["lista", "utfällbar lista", "utfallbar lista", "hopfällbar lista"]),
      group: "Grundblock",
    },
    numbered_list: {
      title: "Numrerad lista",
      subtext: "Lista med ordnade punkter",
      aliases: swedishAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["lista", "numrerad lista", "numrerad"]),
      group: "Grundblock",
    },
    bullet_list: {
      title: "Punktlista",
      subtext: "Lista med oordnade punkter",
      aliases: swedishAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["lista", "punktlista", "punkter"]),
      group: "Grundblock",
    },
    check_list: {
      title: "Checklista",
      subtext: "Lista med kryssrutor",
      aliases: swedishAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["checklista", "att göra", "att gora", "uppgift", "kryssruta"]),
      group: "Grundblock",
    },
    paragraph: {
      title: "Stycke",
      subtext: "Brödtexten i ditt dokument",
      aliases: swedishAliases(["p", "paragraph"], ["stycke", "text"]),
      group: "Grundblock",
    },
    code_block: {
      title: "Kodblock",
      subtext: "Kodblock med syntaxmarkering",
      aliases: swedishAliases(["code", "pre"], ["kod", "kodblock"]),
      group: "Grundblock",
    },
    page_break: {
      title: "Sidbrytning",
      subtext: "Avskiljare mellan sidor",
      aliases: swedishAliases(["page", "break", "separator"], ["sidbrytning", "avskiljare"]),
      group: "Grundblock",
    },
    table: {
      title: "Tabell",
      subtext: "Tabell med redigerbara celler",
      aliases: swedishAliases(["table"], ["tabell"]),
      group: "Avancerat",
    },
    image: {
      title: "Bild",
      subtext: "Bild med bildtext som kan ändras i storlek",
      aliases: swedishAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["bild", "foto", "ladda upp"]),
      group: "Media",
    },
    video: {
      title: "Video",
      subtext: "Video med bildtext som kan ändras i storlek",
      aliases: swedishAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["film", "ladda upp"]),
      group: "Media",
    },
    audio: {
      title: "Ljud",
      subtext: "Inbäddat ljud med bildtext",
      aliases: swedishAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["ljud", "musik", "ladda upp"]),
      group: "Media",
    },
    file: {
      title: "Fil",
      subtext: "Inbäddad fil",
      aliases: swedishAliases(["file", "upload", "embed", "media", "url"], ["fil", "bilaga", "ladda upp", "bädda in", "badda in"]),
      group: "Media",
    },
    emoji: {
      title: "Emoji",
      subtext: "Sök efter och infoga en emoji",
      aliases: swedishAliases(["emoji", "emote", "emotion", "face"], ["smiley", "ansikte", "känsla", "kansla"]),
      group: "Övrigt",
    },
    divider: {
      title: "Avdelare",
      subtext: "Dela upp block visuellt",
      aliases: swedishAliases(["divider", "hr", "line", "horizontal rule"], ["avdelare", "linje", "vågrät linje", "vagrat linje"]),
      group: "Grundblock",
    },
  },
  placeholders: {
    default: "Skriv text eller ”/” för kommandon",
    heading: "Rubrik",
    toggleListItem: "Utfällbar punkt",
    bulletListItem: "Lista",
    numberedListItem: "Lista",
    checkListItem: "Lista",
    emptyDocument: undefined,
    new_comment: "Skriv en kommentar...",
    edit_comment: "Redigera kommentar...",
    comment_reply: "Lägg till kommentar...",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "Lägg till bild",
      video: "Lägg till video",
      audio: "Lägg till ljud",
      file: "Lägg till fil",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "Tomt utfällbart block. Klicka för att lägga till ett block.",
  },
  code_block: {
    add_source_button_text: "Lägg till källkod",
    ok_button_text: "OK",
  },
  // from react package:
  side_menu: {
    add_block_label: "Lägg till block",
    drag_handle_label: "Öppna blockmenyn",
  },
  drag_handle: {
    delete_menuitem: "Radera",
    colors_menuitem: "Färger",
    header_row_menuitem: "Rubrikrad",
    header_column_menuitem: "Rubrikkolumn",
  },
  table_handle: {
    delete_column_menuitem: "Radera kolumn",
    delete_row_menuitem: "Radera rad",
    add_left_menuitem: "Lägg till kolumn till vänster",
    add_right_menuitem: "Lägg till kolumn till höger",
    add_above_menuitem: "Lägg till rad ovanför",
    add_below_menuitem: "Lägg till rad nedanför",
    split_cell_menuitem: "Dela cell",
    merge_cells_menuitem: "Sammanfoga celler",
    background_color_menuitem: "Bakgrundsfärg",
  },
  suggestion_menu: {
    no_items_title: "Inga träffar",
  },
  color_picker: {
    text_title: "Text",
    background_title: "Bakgrund",
    colors: {
      default: "Standard",
      gray: "Grå",
      brown: "Brun",
      red: "Röd",
      orange: "Orange",
      yellow: "Gul",
      green: "Grön",
      blue: "Blå",
      purple: "Lila",
      pink: "Rosa",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "Fetstil",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "Kursiv",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "Understruken",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "Genomstruken",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "Kod",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "Färger",
    },
    link: {
      tooltip: "Skapa länk",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "Redigera bildtext",
      input_placeholder: "Redigera bildtext",
    },
    file_replace: {
      tooltip: {
        image: "Byt bild",
        video: "Byt video",
        audio: "Byt ljud",
        file: "Byt fil",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "Byt namn på bild",
        video: "Byt namn på video",
        audio: "Byt namn på ljud",
        file: "Byt namn på fil",
      } as Record<string, string>,
      input_placeholder: {
        image: "Byt namn på bild",
        video: "Byt namn på video",
        audio: "Byt namn på ljud",
        file: "Byt namn på fil",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "Ladda ned bild",
        video: "Ladda ned video",
        audio: "Ladda ned ljud",
        file: "Ladda ned fil",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "Radera bild",
        video: "Radera video",
        audio: "Radera ljud",
        file: "Radera fil",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "Visa eller dölj förhandsvisning",
    },
    nest: {
      tooltip: "Öka indrag",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "Minska indrag",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "Vänsterjustera",
    },
    align_center: {
      tooltip: "Centrera",
    },
    align_right: {
      tooltip: "Högerjustera",
    },
    align_justify: {
      tooltip: "Marginaljustera",
    },
    table_cell_merge: {
      tooltip: "Sammanfoga celler",
    },
    comment: {
      tooltip: "Lägg till kommentar",
    },
  },
  file_panel: {
    upload: {
      title: "Ladda upp",
      file_placeholder: {
        image: "Ladda upp bild",
        video: "Ladda upp video",
        audio: "Ladda upp ljud",
        file: "Ladda upp fil",
      } as Record<string, string>,
      upload_error: "Fel: uppladdningen misslyckades",
    },
    embed: {
      title: "Bädda in",
      embed_button: {
        image: "Bädda in bild",
        video: "Bädda in video",
        audio: "Bädda in ljud",
        file: "Bädda in fil",
      } as Record<string, string>,
      url_placeholder: "Ange URL",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "Ta bort länk",
    },
    edit: {
      text: "Redigera länk",
      tooltip: "Redigera",
    },
    open: {
      tooltip: "Öppna i ny flik",
    },
    form: {
      title_placeholder: "Redigera titel",
      url_placeholder: "Redigera URL",
    },
  },
  comments: {
    edited: "redigerad",
    save_button_text: "Spara",
    cancel_button_text: "Avbryt",
    deleted_reference_text: "Det ursprungliga innehållet har raderats",
    discard_pending_comment: "Vill du verkligen kasta den här kommentaren?",
    actions: {
      add_reaction: "Lägg till reaktion",
      resolve: "Markera som löst",
      reopen: "Öppna igen",
      edit_comment: "Redigera kommentar",
      delete_comment: "Radera kommentar",
      more_actions: "Fler åtgärder",
    },
    reactions: {
      reacted_by: "Reagerade",
    },
    sidebar: {
      marked_as_resolved: "Markerad som löst",
      more_replies: (count: number) => (count === 1 ? "1 svar till" : `${count} svar till`),
    },
  },
  suggestion_changes: {
    formatting_change: "Formateringsändring",
    deleted: "Raderat",
    inserted_by: (users: string) => `Infogat av ${users}`,
    deleted_by: (users: string) => `Raderat av ${users}`,
    formatting_change_by: (formats: string, users: string) => `Formateringsändring (${formats}) av ${users}`,
  },
  exporter: {
    open_file: "Öppna fil",
    open_video_file: "Öppna video",
    open_audio_file: "Öppna ljud",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "OK",
  },
};
