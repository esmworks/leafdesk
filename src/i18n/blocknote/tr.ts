import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Turkish dictionary; translations of the editor's own UI live here.

/**
 * Slash-menu search terms: BlockNote's English aliases plus Turkish ones, with and without
 * Turkish characters, so typing "başlık", "baslik" or "tablo" finds the item.
 */
function turkishAliases(english: string[], turkish: string[]): string[] {
  return [...english, ...turkish];
}

export const tr: Dictionary = {
  slash_menu: {
    heading: {
      title: "Başlık 1",
      subtext: "En üst düzey başlık",
      aliases: turkishAliases(["h", "heading1", "h1"], ["başlık", "baslik", "başlık1", "baslik1"]),
      group: "Başlıklar",
    },
    heading_2: {
      title: "Başlık 2",
      subtext: "Ana bölüm başlığı",
      aliases: turkishAliases(["h2", "heading2", "subheading"], ["başlık2", "baslik2", "alt başlık", "alt baslik"]),
      group: "Başlıklar",
    },
    heading_3: {
      title: "Başlık 3",
      subtext: "Alt bölüm ve grup başlığı",
      aliases: turkishAliases(["h3", "heading3", "subheading"], ["başlık3", "baslik3", "alt başlık", "alt baslik"]),
      group: "Başlıklar",
    },
    heading_4: {
      title: "Başlık 4",
      subtext: "Küçük alt bölüm başlığı",
      aliases: turkishAliases(["h4", "heading4", "subheading4"], ["başlık4", "baslik4", "alt başlık", "alt baslik"]),
      group: "Alt başlıklar",
    },
    heading_5: {
      title: "Başlık 5",
      subtext: "Küçük alt bölüm başlığı",
      aliases: turkishAliases(["h5", "heading5", "subheading5"], ["başlık5", "baslik5", "alt başlık", "alt baslik"]),
      group: "Alt başlıklar",
    },
    heading_6: {
      title: "Başlık 6",
      subtext: "En alt düzey başlık",
      aliases: turkishAliases(["h6", "heading6", "subheading6"], ["başlık6", "baslik6", "alt başlık", "alt baslik"]),
      group: "Alt başlıklar",
    },
    toggle_heading: {
      title: "Açılır başlık 1",
      subtext: "Açılıp kapanabilen üst düzey başlık",
      aliases: turkishAliases(["h", "heading1", "h1", "collapsable"], ["başlık", "baslik", "açılır", "acilir", "katlanır", "katlanir"]),
      group: "Alt başlıklar",
    },
    toggle_heading_2: {
      title: "Açılır başlık 2",
      subtext: "Açılıp kapanabilen ana bölüm başlığı",
      aliases: turkishAliases(["h2", "heading2", "subheading", "collapsable"], ["başlık2", "baslik2", "açılır", "acilir", "katlanır", "katlanir"]),
      group: "Alt başlıklar",
    },
    toggle_heading_3: {
      title: "Açılır başlık 3",
      subtext: "Açılıp kapanabilen alt bölüm ve grup başlığı",
      aliases: turkishAliases(["h3", "heading3", "subheading", "collapsable"], ["başlık3", "baslik3", "açılır", "acilir", "katlanır", "katlanir"]),
      group: "Alt başlıklar",
    },
    quote: {
      title: "Alıntı",
      subtext: "Alıntı veya pasaj",
      aliases: turkishAliases(["quotation", "blockquote", "bq"], ["quote", "alıntı", "alinti"]),
      group: "Temel bloklar",
    },
    toggle_list: {
      title: "Açılır liste",
      subtext: "Alt öğeleri gizlenebilen liste",
      aliases: turkishAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["liste", "açılır liste", "acilir liste", "katlanır liste", "katlanir liste"]),
      group: "Temel bloklar",
    },
    numbered_list: {
      title: "Numaralı liste",
      subtext: "Sıralı öğeler içeren liste",
      aliases: turkishAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["liste", "numaralı liste", "numarali liste", "sıralı liste", "sirali liste"]),
      group: "Temel bloklar",
    },
    bullet_list: {
      title: "Madde işaretli liste",
      subtext: "Sırasız öğeler içeren liste",
      aliases: turkishAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["liste", "madde işaretli liste", "madde isaretli liste"]),
      group: "Temel bloklar",
    },
    check_list: {
      title: "Yapılacaklar listesi",
      subtext: "Onay kutulu liste",
      aliases: turkishAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["liste", "yapılacaklar", "yapilacaklar", "onay kutusu", "görev", "gorev"]),
      group: "Temel bloklar",
    },
    paragraph: {
      title: "Paragraf",
      subtext: "Belgenizin gövde metni",
      aliases: turkishAliases(["p", "paragraph"], ["paragraf", "metin"]),
      group: "Temel bloklar",
    },
    code_block: {
      title: "Kod bloğu",
      subtext: "Söz dizimi vurgulamalı kod bloğu",
      aliases: turkishAliases(["code", "pre"], ["kod bloğu", "kod blogu"]),
      group: "Temel bloklar",
    },
    page_break: {
      title: "Sayfa sonu",
      subtext: "Sayfa ayırıcı",
      aliases: turkishAliases(["page", "break", "separator"], ["sayfa sonu", "ayırıcı", "ayirici"]),
      group: "Temel bloklar",
    },
    table: {
      title: "Tablo",
      subtext: "Düzenlenebilir hücreli tablo",
      aliases: turkishAliases(["table"], ["tablo"]),
      group: "Gelişmiş",
    },
    image: {
      title: "Görsel",
      subtext: "Boyutlandırılabilir, açıklamalı görsel",
      aliases: turkishAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["görsel", "gorsel", "resim", "fotoğraf", "fotograf", "yükle", "yukle", "medya"]),
      group: "Medya",
    },
    video: {
      title: "Video",
      subtext: "Boyutlandırılabilir, açıklamalı video",
      aliases: turkishAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["yükle", "yukle", "medya"]),
      group: "Medya",
    },
    audio: {
      title: "Ses",
      subtext: "Açıklamalı gömülü ses",
      aliases: turkishAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["ses", "müzik", "muzik", "yükle", "yukle", "medya"]),
      group: "Medya",
    },
    file: {
      title: "Dosya",
      subtext: "Gömülü dosya",
      aliases: turkishAliases(["file", "upload", "embed", "media", "url"], ["dosya", "yükle", "yukle", "medya"]),
      group: "Medya",
    },
    emoji: {
      title: "Emoji",
      subtext: "Emoji arayıp ekleyin",
      aliases: turkishAliases(["emoji", "emote", "emotion", "face"], ["ifade", "surat"]),
      group: "Diğer",
    },
    divider: {
      title: "Ayırıcı",
      subtext: "Blokları görsel olarak ayırın",
      aliases: turkishAliases(["divider", "hr", "line", "horizontal rule"], ["ayırıcı", "ayirici", "yatay çizgi", "yatay cizgi"]),
      group: "Temel bloklar",
    },
  },
  placeholders: {
    default: "Yazmaya başlayın veya komutlar için '/' yazın",
    heading: "Başlık",
    toggleListItem: "Açılır öğe",
    bulletListItem: "Liste",
    numberedListItem: "Liste",
    checkListItem: "Liste",
    emptyDocument: undefined,
    new_comment: "Yorum yazın...",
    edit_comment: "Yorumu düzenleyin...",
    comment_reply: "Yorum ekleyin...",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "Görsel ekle",
      video: "Video ekle",
      audio: "Ses ekle",
      file: "Dosya ekle",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "Boş açılır öğe. Blok eklemek için tıklayın.",
  },
  code_block: {
    add_source_button_text: "Kaynak kod ekle",
    ok_button_text: "Tamam",
  },
  // from react package:
  side_menu: {
    add_block_label: "Blok ekle",
    drag_handle_label: "Blok menüsünü aç",
  },
  drag_handle: {
    delete_menuitem: "Sil",
    colors_menuitem: "Renkler",
    header_row_menuitem: "Başlık satırı",
    header_column_menuitem: "Başlık sütunu",
  },
  table_handle: {
    delete_column_menuitem: "Sütunu sil",
    delete_row_menuitem: "Satırı sil",
    add_left_menuitem: "Sola sütun ekle",
    add_right_menuitem: "Sağa sütun ekle",
    add_above_menuitem: "Üste satır ekle",
    add_below_menuitem: "Alta satır ekle",
    split_cell_menuitem: "Hücreyi böl",
    merge_cells_menuitem: "Hücreleri birleştir",
    background_color_menuitem: "Arka plan rengi",
  },
  suggestion_menu: {
    no_items_title: "Sonuç bulunamadı",
  },
  color_picker: {
    text_title: "Metin",
    background_title: "Arka plan",
    colors: {
      default: "Otomatik",
      gray: "Gri",
      brown: "Kahverengi",
      red: "Kırmızı",
      orange: "Turuncu",
      yellow: "Sarı",
      green: "Yeşil",
      blue: "Mavi",
      purple: "Mor",
      pink: "Pembe",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "Kalın",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "İtalik",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "Altı çizili",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "Üstü çizili",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "Kod",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "Renkler",
    },
    link: {
      tooltip: "Bağlantı oluştur",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "Açıklamayı düzenle",
      input_placeholder: "Açıklamayı düzenleyin",
    },
    file_replace: {
      tooltip: {
        image: "Görseli değiştir",
        video: "Videoyu değiştir",
        audio: "Sesi değiştir",
        file: "Dosyayı değiştir",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "Görseli yeniden adlandır",
        video: "Videoyu yeniden adlandır",
        audio: "Sesi yeniden adlandır",
        file: "Dosyayı yeniden adlandır",
      } as Record<string, string>,
      input_placeholder: {
        image: "Görseli yeniden adlandırın",
        video: "Videoyu yeniden adlandırın",
        audio: "Sesi yeniden adlandırın",
        file: "Dosyayı yeniden adlandırın",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "Görseli indir",
        video: "Videoyu indir",
        audio: "Sesi indir",
        file: "Dosyayı indir",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "Görseli sil",
        video: "Videoyu sil",
        audio: "Sesi sil",
        file: "Dosyayı sil",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "Önizlemeyi aç/kapat",
    },
    nest: {
      tooltip: "İçeri al",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "Dışarı al",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "Sola hizala",
    },
    align_center: {
      tooltip: "Ortala",
    },
    align_right: {
      tooltip: "Sağa hizala",
    },
    align_justify: {
      tooltip: "İki yana yasla",
    },
    table_cell_merge: {
      tooltip: "Hücreleri birleştir",
    },
    comment: {
      tooltip: "Yorum ekle",
    },
  },
  file_panel: {
    upload: {
      title: "Yükle",
      file_placeholder: {
        image: "Görsel yükle",
        video: "Video yükle",
        audio: "Ses yükle",
        file: "Dosya yükle",
      } as Record<string, string>,
      upload_error: "Hata: Yükleme başarısız oldu",
    },
    embed: {
      title: "Göm",
      embed_button: {
        image: "Görseli göm",
        video: "Videoyu göm",
        audio: "Sesi göm",
        file: "Dosyayı göm",
      } as Record<string, string>,
      url_placeholder: "URL girin",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "Bağlantıyı kaldır",
    },
    edit: {
      text: "Bağlantıyı düzenle",
      tooltip: "Düzenle",
    },
    open: {
      tooltip: "Yeni sekmede aç",
    },
    form: {
      title_placeholder: "Başlığı düzenleyin",
      url_placeholder: "URL'yi düzenleyin",
    },
  },
  comments: {
    edited: "düzenlendi",
    save_button_text: "Kaydet",
    cancel_button_text: "İptal",
    deleted_reference_text: "Orijinal içerik silindi",
    discard_pending_comment: "Bu yorumdan vazgeçmek istediğinizden emin misiniz?",
    actions: {
      add_reaction: "Tepki ekle",
      resolve: "Çözüldü olarak işaretle",
      reopen: "Yeniden aç",
      edit_comment: "Yorumu düzenle",
      delete_comment: "Yorumu sil",
      more_actions: "Diğer işlemler",
    },
    reactions: {
      reacted_by: "Tepki verenler",
    },
    sidebar: {
      marked_as_resolved: "Çözüldü olarak işaretlendi",
      more_replies: (count: number) => `${count} yanıt daha`,
    },
  },
  suggestion_changes: {
    formatting_change: "Biçim değişikliği",
    deleted: "Silindi",
    inserted_by: (users: string) => `Ekleyen: ${users}`,
    deleted_by: (users: string) => `Silen: ${users}`,
    formatting_change_by: (formats: string, users: string) => `Biçim değişikliği (${formats}), yapan: ${users}`,
  },
  exporter: {
    open_file: "Dosyayı aç",
    open_video_file: "Videoyu aç",
    open_audio_file: "Sesi aç",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "Tamam",
  },
};
