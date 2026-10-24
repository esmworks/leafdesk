import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Danish dictionary; translations of the editor's own UI live here.

/**
 * Slash-menu search terms: BlockNote's English aliases plus Danish ones, with and without
 * Danish letters (æ → ae, ø → oe, å → aa), so typing "overskrift", "billede" or "tabel" finds the item.
 */
function danishAliases(english: string[], danish: string[]): string[] {
  return [...english, ...danish];
}

export const da: Dictionary = {
  slash_menu: {
    heading: {
      title: "Overskrift 1",
      subtext: "Overskrift på øverste niveau",
      aliases: danishAliases(["h", "heading1", "h1"], ["overskrift", "overskrift1"]),
      group: "Overskrifter",
    },
    heading_2: {
      title: "Overskrift 2",
      subtext: "Overskrift til vigtige afsnit",
      aliases: danishAliases(["h2", "heading2", "subheading"], ["overskrift2", "underoverskrift"]),
      group: "Overskrifter",
    },
    heading_3: {
      title: "Overskrift 3",
      subtext: "Overskrift til underafsnit og grupper",
      aliases: danishAliases(["h3", "heading3", "subheading"], ["overskrift3", "underoverskrift"]),
      group: "Overskrifter",
    },
    heading_4: {
      title: "Overskrift 4",
      subtext: "Overskrift til mindre underafsnit",
      aliases: danishAliases(["h4", "heading4", "subheading4"], ["overskrift4", "underoverskrift"]),
      group: "Underoverskrifter",
    },
    heading_5: {
      title: "Overskrift 5",
      subtext: "Overskrift til mindre underafsnit",
      aliases: danishAliases(["h5", "heading5", "subheading5"], ["overskrift5", "underoverskrift"]),
      group: "Underoverskrifter",
    },
    heading_6: {
      title: "Overskrift 6",
      subtext: "Overskrift på laveste niveau",
      aliases: danishAliases(["h6", "heading6", "subheading6"], ["overskrift6", "underoverskrift"]),
      group: "Underoverskrifter",
    },
    toggle_heading: {
      title: "Fold-ud-overskrift 1",
      subtext: "Overskrift på øverste niveau, der kan foldes ud og sammen",
      aliases: danishAliases(["h", "heading1", "h1", "collapsable"], ["overskrift", "fold-ud", "fold ud", "sammenfoldelig"]),
      group: "Underoverskrifter",
    },
    toggle_heading_2: {
      title: "Fold-ud-overskrift 2",
      subtext: "Overskrift til vigtige afsnit, der kan foldes ud og sammen",
      aliases: danishAliases(["h2", "heading2", "subheading", "collapsable"], ["overskrift2", "fold-ud", "fold ud", "sammenfoldelig"]),
      group: "Underoverskrifter",
    },
    toggle_heading_3: {
      title: "Fold-ud-overskrift 3",
      subtext: "Overskrift til underafsnit og grupper, der kan foldes ud og sammen",
      aliases: danishAliases(["h3", "heading3", "subheading", "collapsable"], ["overskrift3", "fold-ud", "fold ud", "sammenfoldelig"]),
      group: "Underoverskrifter",
    },
    quote: {
      title: "Citat",
      subtext: "Citat eller uddrag",
      aliases: danishAliases(["quotation", "blockquote", "bq"], ["quote", "citat"]),
      group: "Grundlæggende blokke",
    },
    toggle_list: {
      title: "Fold-ud-liste",
      subtext: "Liste med underpunkter, der kan skjules",
      aliases: danishAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["liste", "fold-ud-liste", "fold ud liste", "sammenfoldelig liste"]),
      group: "Grundlæggende blokke",
    },
    numbered_list: {
      title: "Nummereret liste",
      subtext: "Liste med ordnede punkter",
      aliases: danishAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["liste", "nummereret liste", "nummerliste"]),
      group: "Grundlæggende blokke",
    },
    bullet_list: {
      title: "Punktopstilling",
      subtext: "Liste med uordnede punkter",
      aliases: danishAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["liste", "punktopstilling", "punktliste", "punkter"]),
      group: "Grundlæggende blokke",
    },
    check_list: {
      title: "Tjekliste",
      subtext: "Liste med afkrydsningsfelter",
      aliases: danishAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["liste", "tjekliste", "opgaver", "opgave", "afkrydsningsfelt", "to do"]),
      group: "Grundlæggende blokke",
    },
    paragraph: {
      title: "Afsnit",
      subtext: "Brødteksten i dit dokument",
      aliases: danishAliases(["p", "paragraph"], ["afsnit", "tekst", "brødtekst", "broedtekst"]),
      group: "Grundlæggende blokke",
    },
    code_block: {
      title: "Kodeblok",
      subtext: "Kodeblok med syntaksfremhævning",
      aliases: danishAliases(["code", "pre"], ["kode", "kodeblok"]),
      group: "Grundlæggende blokke",
    },
    page_break: {
      title: "Sideskift",
      subtext: "Sideadskiller",
      aliases: danishAliases(["page", "break", "separator"], ["sideskift", "skillelinje", "adskiller"]),
      group: "Grundlæggende blokke",
    },
    table: {
      title: "Tabel",
      subtext: "Tabel med redigerbare celler",
      aliases: danishAliases(["table"], ["tabel"]),
      group: "Avanceret",
    },
    image: {
      title: "Billede",
      subtext: "Billede med justerbar størrelse og billedtekst",
      aliases: danishAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["billede", "foto", "upload", "medier"]),
      group: "Medier",
    },
    video: {
      title: "Video",
      subtext: "Video med justerbar størrelse og billedtekst",
      aliases: danishAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["upload", "medier"]),
      group: "Medier",
    },
    audio: {
      title: "Lyd",
      subtext: "Indlejret lyd med billedtekst",
      aliases: danishAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["lyd", "musik", "upload", "medier"]),
      group: "Medier",
    },
    file: {
      title: "Fil",
      subtext: "Indlejret fil",
      aliases: danishAliases(["file", "upload", "embed", "media", "url"], ["fil", "upload", "indlejr", "medier"]),
      group: "Medier",
    },
    emoji: {
      title: "Emoji",
      subtext: "Søg efter og indsæt en emoji",
      aliases: danishAliases(["emoji", "emote", "emotion", "face"], ["smiley", "ansigt"]),
      group: "Andet",
    },
    divider: {
      title: "Skillelinje",
      subtext: "Adskil blokke visuelt",
      aliases: danishAliases(["divider", "hr", "line", "horizontal rule"], ["skillelinje", "linje", "vandret linje"]),
      group: "Grundlæggende blokke",
    },
  },
  placeholders: {
    default: "Begynd at skrive, eller skriv '/' for kommandoer",
    heading: "Overskrift",
    toggleListItem: "Fold-ud-punkt",
    bulletListItem: "Liste",
    numberedListItem: "Liste",
    checkListItem: "Liste",
    emptyDocument: undefined,
    new_comment: "Skriv en kommentar…",
    edit_comment: "Redigér kommentar…",
    comment_reply: "Tilføj en kommentar…",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "Tilføj billede",
      video: "Tilføj video",
      audio: "Tilføj lyd",
      file: "Tilføj fil",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "Tomt fold-ud-punkt. Klik for at tilføje en blok.",
  },
  code_block: {
    add_source_button_text: "Tilføj kildekode",
    ok_button_text: "OK",
  },
  // from react package:
  side_menu: {
    add_block_label: "Tilføj blok",
    drag_handle_label: "Åbn blokmenu",
  },
  drag_handle: {
    delete_menuitem: "Slet",
    colors_menuitem: "Farver",
    header_row_menuitem: "Overskriftsrække",
    header_column_menuitem: "Overskriftskolonne",
  },
  table_handle: {
    delete_column_menuitem: "Slet kolonne",
    delete_row_menuitem: "Slet række",
    add_left_menuitem: "Tilføj kolonne til venstre",
    add_right_menuitem: "Tilføj kolonne til højre",
    add_above_menuitem: "Tilføj række over",
    add_below_menuitem: "Tilføj række under",
    split_cell_menuitem: "Del celle",
    merge_cells_menuitem: "Flet celler",
    background_color_menuitem: "Baggrundsfarve",
  },
  suggestion_menu: {
    no_items_title: "Ingen resultater fundet",
  },
  color_picker: {
    text_title: "Tekst",
    background_title: "Baggrund",
    colors: {
      default: "Standard",
      gray: "Grå",
      brown: "Brun",
      red: "Rød",
      orange: "Orange",
      yellow: "Gul",
      green: "Grøn",
      blue: "Blå",
      purple: "Lilla",
      pink: "Lyserød",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "Fed",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "Kursiv",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "Understreget",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "Gennemstreget",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "Kode",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "Farver",
    },
    link: {
      tooltip: "Opret link",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "Redigér billedtekst",
      input_placeholder: "Redigér billedtekst",
    },
    file_replace: {
      tooltip: {
        image: "Erstat billede",
        video: "Erstat video",
        audio: "Erstat lyd",
        file: "Erstat fil",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "Omdøb billede",
        video: "Omdøb video",
        audio: "Omdøb lyd",
        file: "Omdøb fil",
      } as Record<string, string>,
      input_placeholder: {
        image: "Omdøb billede",
        video: "Omdøb video",
        audio: "Omdøb lyd",
        file: "Omdøb fil",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "Download billede",
        video: "Download video",
        audio: "Download lyd",
        file: "Download fil",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "Slet billede",
        video: "Slet video",
        audio: "Slet lyd",
        file: "Slet fil",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "Slå forhåndsvisning til/fra",
    },
    nest: {
      tooltip: "Ryk ind",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "Ryk ud",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "Venstrejustér",
    },
    align_center: {
      tooltip: "Centrér",
    },
    align_right: {
      tooltip: "Højrejustér",
    },
    align_justify: {
      tooltip: "Lige margener",
    },
    table_cell_merge: {
      tooltip: "Flet celler",
    },
    comment: {
      tooltip: "Tilføj kommentar",
    },
  },
  file_panel: {
    upload: {
      title: "Upload",
      file_placeholder: {
        image: "Upload billede",
        video: "Upload video",
        audio: "Upload lyd",
        file: "Upload fil",
      } as Record<string, string>,
      upload_error: "Fejl: Upload mislykkedes",
    },
    embed: {
      title: "Indlejr",
      embed_button: {
        image: "Indlejr billede",
        video: "Indlejr video",
        audio: "Indlejr lyd",
        file: "Indlejr fil",
      } as Record<string, string>,
      url_placeholder: "Angiv URL",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "Fjern link",
    },
    edit: {
      text: "Redigér link",
      tooltip: "Redigér",
    },
    open: {
      tooltip: "Åbn i ny fane",
    },
    form: {
      title_placeholder: "Redigér titel",
      url_placeholder: "Redigér URL",
    },
  },
  comments: {
    edited: "redigeret",
    save_button_text: "Gem",
    cancel_button_text: "Annuller",
    deleted_reference_text: "Det oprindelige indhold er slettet",
    discard_pending_comment: "Er du sikker på, at du vil kassere denne kommentar?",
    actions: {
      add_reaction: "Tilføj reaktion",
      resolve: "Markér som løst",
      reopen: "Genåbn",
      edit_comment: "Redigér kommentar",
      delete_comment: "Slet kommentar",
      more_actions: "Flere handlinger",
    },
    reactions: {
      reacted_by: "Reageret af",
    },
    sidebar: {
      marked_as_resolved: "Markeret som løst",
      more_replies: (count: number) => (count === 1 ? "1 svar mere" : `${count} svar mere`),
    },
  },
  suggestion_changes: {
    formatting_change: "Formateringsændring",
    deleted: "Slettet",
    inserted_by: (users: string) => `Indsat af ${users}`,
    deleted_by: (users: string) => `Slettet af ${users}`,
    formatting_change_by: (formats: string, users: string) => `Formateringsændring (${formats}) af ${users}`,
  },
  exporter: {
    open_file: "Åbn fil",
    open_video_file: "Åbn video",
    open_audio_file: "Åbn lyd",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "OK",
  },
};
