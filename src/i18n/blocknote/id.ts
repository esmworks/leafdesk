import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Indonesian dictionary; translations of the editor's own UI live here.

/**
 * Slash-menu search terms: BlockNote's English aliases plus Indonesian ones, so typing
 * "judul", "tabel" or "daftar" finds the item.
 */
function indonesianAliases(english: string[], indonesian: string[]): string[] {
  return [...english, ...indonesian];
}

export const id: Dictionary = {
  slash_menu: {
    heading: {
      title: "Judul 1",
      subtext: "Judul tingkat teratas",
      aliases: indonesianAliases(["h", "heading1", "h1"], ["judul", "judul1"]),
      group: "Judul",
    },
    heading_2: {
      title: "Judul 2",
      subtext: "Judul bagian utama",
      aliases: indonesianAliases(["h2", "heading2", "subheading"], ["judul2", "subjudul"]),
      group: "Judul",
    },
    heading_3: {
      title: "Judul 3",
      subtext: "Judul subbagian dan kelompok",
      aliases: indonesianAliases(["h3", "heading3", "subheading"], ["judul3", "subjudul"]),
      group: "Judul",
    },
    heading_4: {
      title: "Judul 4",
      subtext: "Judul subbagian kecil",
      aliases: indonesianAliases(["h4", "heading4", "subheading4"], ["judul4", "subjudul"]),
      group: "Subjudul",
    },
    heading_5: {
      title: "Judul 5",
      subtext: "Judul subbagian mungil",
      aliases: indonesianAliases(["h5", "heading5", "subheading5"], ["judul5", "subjudul"]),
      group: "Subjudul",
    },
    heading_6: {
      title: "Judul 6",
      subtext: "Judul tingkat terendah",
      aliases: indonesianAliases(["h6", "heading6", "subheading6"], ["judul6", "subjudul"]),
      group: "Subjudul",
    },
    toggle_heading: {
      title: "Judul lipat 1",
      subtext: "Judul tingkat teratas yang dapat dilipat",
      aliases: indonesianAliases(["h", "heading1", "h1", "collapsable"], ["judul", "lipat", "ciut"]),
      group: "Subjudul",
    },
    toggle_heading_2: {
      title: "Judul lipat 2",
      subtext: "Judul bagian utama yang dapat dilipat",
      aliases: indonesianAliases(["h2", "heading2", "subheading", "collapsable"], ["judul2", "lipat", "ciut"]),
      group: "Subjudul",
    },
    toggle_heading_3: {
      title: "Judul lipat 3",
      subtext: "Judul subbagian dan kelompok yang dapat dilipat",
      aliases: indonesianAliases(["h3", "heading3", "subheading", "collapsable"], ["judul3", "lipat", "ciut"]),
      group: "Subjudul",
    },
    quote: {
      title: "Kutipan",
      subtext: "Kutipan atau petikan",
      aliases: indonesianAliases(["quotation", "blockquote", "bq"], ["quote", "kutipan", "petikan"]),
      group: "Blok dasar",
    },
    toggle_list: {
      title: "Daftar lipat",
      subtext: "Daftar dengan subitem yang dapat disembunyikan",
      aliases: indonesianAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["daftar", "daftar lipat"]),
      group: "Blok dasar",
    },
    numbered_list: {
      title: "Daftar bernomor",
      subtext: "Daftar dengan item berurutan",
      aliases: indonesianAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["daftar", "daftar bernomor", "daftar berurutan"]),
      group: "Blok dasar",
    },
    bullet_list: {
      title: "Daftar berpoin",
      subtext: "Daftar dengan item tidak berurutan",
      aliases: indonesianAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["daftar", "daftar berpoin", "poin"]),
      group: "Blok dasar",
    },
    check_list: {
      title: "Daftar centang",
      subtext: "Daftar dengan kotak centang",
      aliases: indonesianAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["daftar", "centang", "kotak centang", "tugas"]),
      group: "Blok dasar",
    },
    paragraph: {
      title: "Paragraf",
      subtext: "Isi dokumen Anda",
      aliases: indonesianAliases(["p", "paragraph"], ["paragraf", "teks"]),
      group: "Blok dasar",
    },
    code_block: {
      title: "Blok kode",
      subtext: "Blok kode dengan penyorotan sintaks",
      aliases: indonesianAliases(["code", "pre"], ["kode", "blok kode"]),
      group: "Blok dasar",
    },
    page_break: {
      title: "Pemisah halaman",
      subtext: "Pembatas halaman",
      aliases: indonesianAliases(["page", "break", "separator"], ["pemisah halaman", "pembatas"]),
      group: "Blok dasar",
    },
    table: {
      title: "Tabel",
      subtext: "Tabel dengan sel yang dapat diedit",
      aliases: indonesianAliases(["table"], ["tabel"]),
      group: "Lanjutan",
    },
    image: {
      title: "Gambar",
      subtext: "Gambar yang dapat diubah ukurannya dengan keterangan",
      aliases: indonesianAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["gambar", "foto", "unggah", "media"]),
      group: "Media",
    },
    video: {
      title: "Video",
      subtext: "Video yang dapat diubah ukurannya dengan keterangan",
      aliases: indonesianAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["unggah", "media"]),
      group: "Media",
    },
    audio: {
      title: "Audio",
      subtext: "Audio tersemat dengan keterangan",
      aliases: indonesianAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["suara", "musik", "unggah", "media"]),
      group: "Media",
    },
    file: {
      title: "Berkas",
      subtext: "Berkas tersemat",
      aliases: indonesianAliases(["file", "upload", "embed", "media", "url"], ["berkas", "file", "unggah", "media"]),
      group: "Media",
    },
    emoji: {
      title: "Emoji",
      subtext: "Cari dan sisipkan emoji",
      aliases: indonesianAliases(["emoji", "emote", "emotion", "face"], ["ekspresi", "wajah"]),
      group: "Lainnya",
    },
    divider: {
      title: "Pemisah",
      subtext: "Pisahkan blok secara visual",
      aliases: indonesianAliases(["divider", "hr", "line", "horizontal rule"], ["pemisah", "garis", "garis horizontal"]),
      group: "Blok dasar",
    },
  },
  placeholders: {
    default: "Mulai mengetik atau ketik '/' untuk perintah",
    heading: "Judul",
    toggleListItem: "Item lipat",
    bulletListItem: "Daftar",
    numberedListItem: "Daftar",
    checkListItem: "Daftar",
    emptyDocument: undefined,
    new_comment: "Tulis komentar...",
    edit_comment: "Edit komentar...",
    comment_reply: "Tambahkan komentar...",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "Tambah gambar",
      video: "Tambah video",
      audio: "Tambah audio",
      file: "Tambah berkas",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "Item lipat kosong. Klik untuk menambahkan blok.",
  },
  code_block: {
    add_source_button_text: "Tambah kode sumber",
    ok_button_text: "OK",
  },
  // from react package:
  side_menu: {
    add_block_label: "Tambah blok",
    drag_handle_label: "Buka menu blok",
  },
  drag_handle: {
    delete_menuitem: "Hapus",
    colors_menuitem: "Warna",
    header_row_menuitem: "Baris header",
    header_column_menuitem: "Kolom header",
  },
  table_handle: {
    delete_column_menuitem: "Hapus kolom",
    delete_row_menuitem: "Hapus baris",
    add_left_menuitem: "Tambah kolom di kiri",
    add_right_menuitem: "Tambah kolom di kanan",
    add_above_menuitem: "Tambah baris di atas",
    add_below_menuitem: "Tambah baris di bawah",
    split_cell_menuitem: "Pisahkan sel",
    merge_cells_menuitem: "Gabungkan sel",
    background_color_menuitem: "Warna latar",
  },
  suggestion_menu: {
    no_items_title: "Tidak ada hasil",
  },
  color_picker: {
    text_title: "Teks",
    background_title: "Latar",
    colors: {
      default: "Otomatis",
      gray: "Abu-abu",
      brown: "Cokelat",
      red: "Merah",
      orange: "Oranye",
      yellow: "Kuning",
      green: "Hijau",
      blue: "Biru",
      purple: "Ungu",
      pink: "Merah muda",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "Tebal",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "Miring",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "Garis bawah",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "Coret",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "Kode",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "Warna",
    },
    link: {
      tooltip: "Buat tautan",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "Edit keterangan",
      input_placeholder: "Edit keterangan",
    },
    file_replace: {
      tooltip: {
        image: "Ganti gambar",
        video: "Ganti video",
        audio: "Ganti audio",
        file: "Ganti berkas",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "Ubah nama gambar",
        video: "Ubah nama video",
        audio: "Ubah nama audio",
        file: "Ubah nama berkas",
      } as Record<string, string>,
      input_placeholder: {
        image: "Ubah nama gambar",
        video: "Ubah nama video",
        audio: "Ubah nama audio",
        file: "Ubah nama berkas",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "Unduh gambar",
        video: "Unduh video",
        audio: "Unduh audio",
        file: "Unduh berkas",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "Hapus gambar",
        video: "Hapus video",
        audio: "Hapus audio",
        file: "Hapus berkas",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "Aktifkan/matikan pratinjau",
    },
    nest: {
      tooltip: "Menjorok ke dalam",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "Keluarkan dari jorokan",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "Rata kiri",
    },
    align_center: {
      tooltip: "Rata tengah",
    },
    align_right: {
      tooltip: "Rata kanan",
    },
    align_justify: {
      tooltip: "Rata kiri-kanan",
    },
    table_cell_merge: {
      tooltip: "Gabungkan sel",
    },
    comment: {
      tooltip: "Tambah komentar",
    },
  },
  file_panel: {
    upload: {
      title: "Unggah",
      file_placeholder: {
        image: "Unggah gambar",
        video: "Unggah video",
        audio: "Unggah audio",
        file: "Unggah berkas",
      } as Record<string, string>,
      upload_error: "Kesalahan: Pengunggahan gagal",
    },
    embed: {
      title: "Sematkan",
      embed_button: {
        image: "Sematkan gambar",
        video: "Sematkan video",
        audio: "Sematkan audio",
        file: "Sematkan berkas",
      } as Record<string, string>,
      url_placeholder: "Masukkan URL",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "Hapus tautan",
    },
    edit: {
      text: "Edit tautan",
      tooltip: "Edit",
    },
    open: {
      tooltip: "Buka di tab baru",
    },
    form: {
      title_placeholder: "Edit judul",
      url_placeholder: "Edit URL",
    },
  },
  comments: {
    edited: "diedit",
    save_button_text: "Simpan",
    cancel_button_text: "Batal",
    deleted_reference_text: "Konten asli telah dihapus",
    discard_pending_comment: "Yakin ingin membuang komentar ini?",
    actions: {
      add_reaction: "Tambah reaksi",
      resolve: "Tandai selesai",
      reopen: "Buka kembali",
      edit_comment: "Edit komentar",
      delete_comment: "Hapus komentar",
      more_actions: "Tindakan lainnya",
    },
    reactions: {
      reacted_by: "Direaksi oleh",
    },
    sidebar: {
      marked_as_resolved: "Ditandai selesai",
      more_replies: (count: number) => `${count} balasan lagi`,
    },
  },
  suggestion_changes: {
    formatting_change: "Perubahan format",
    deleted: "Dihapus",
    inserted_by: (users: string) => `Disisipkan oleh ${users}`,
    deleted_by: (users: string) => `Dihapus oleh ${users}`,
    formatting_change_by: (formats: string, users: string) => `Perubahan format (${formats}) oleh ${users}`,
  },
  exporter: {
    open_file: "Buka berkas",
    open_video_file: "Buka video",
    open_audio_file: "Buka audio",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "OK",
  },
};
