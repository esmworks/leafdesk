import type { Dictionary } from "@blocknote/core";

// BlockNote ships no Thai dictionary; translations of the editor's own UI live here.

/** Slash-menu search terms: BlockNote's English aliases plus Thai ones, so typing "หัวข้อ" or "ตาราง" finds the item. */
function thaiAliases(english: string[], thai: string[]): string[] {
  return [...english, ...thai];
}

export const th: Dictionary = {
  slash_menu: {
    heading: {
      title: "หัวข้อ 1",
      subtext: "หัวข้อระดับบนสุด",
      aliases: thaiAliases(["h", "heading1", "h1"], ["หัวข้อ", "หัวข้อ1", "หัวข้อใหญ่"]),
      group: "หัวข้อ",
    },
    heading_2: {
      title: "หัวข้อ 2",
      subtext: "หัวข้อส่วนหลัก",
      aliases: thaiAliases(["h2", "heading2", "subheading"], ["หัวข้อ2", "หัวข้อรอง"]),
      group: "หัวข้อ",
    },
    heading_3: {
      title: "หัวข้อ 3",
      subtext: "หัวข้อส่วนย่อยและกลุ่ม",
      aliases: thaiAliases(["h3", "heading3", "subheading"], ["หัวข้อ3", "หัวข้อรอง"]),
      group: "หัวข้อ",
    },
    heading_4: {
      title: "หัวข้อ 4",
      subtext: "หัวข้อส่วนย่อยขนาดเล็ก",
      aliases: thaiAliases(["h4", "heading4", "subheading4"], ["หัวข้อ4", "หัวข้อรอง"]),
      group: "หัวข้อย่อย",
    },
    heading_5: {
      title: "หัวข้อ 5",
      subtext: "หัวข้อส่วนย่อยขนาดเล็ก",
      aliases: thaiAliases(["h5", "heading5", "subheading5"], ["หัวข้อ5", "หัวข้อรอง"]),
      group: "หัวข้อย่อย",
    },
    heading_6: {
      title: "หัวข้อ 6",
      subtext: "หัวข้อระดับล่างสุด",
      aliases: thaiAliases(["h6", "heading6", "subheading6"], ["หัวข้อ6", "หัวข้อรอง"]),
      group: "หัวข้อย่อย",
    },
    toggle_heading: {
      title: "หัวข้อแบบพับได้ 1",
      subtext: "หัวข้อระดับบนสุดที่พับและขยายได้",
      aliases: thaiAliases(["h", "heading1", "h1", "collapsable"], ["หัวข้อ", "พับได้", "พับ", "ขยาย"]),
      group: "หัวข้อย่อย",
    },
    toggle_heading_2: {
      title: "หัวข้อแบบพับได้ 2",
      subtext: "หัวข้อส่วนหลักที่พับและขยายได้",
      aliases: thaiAliases(["h2", "heading2", "subheading", "collapsable"], ["หัวข้อ2", "พับได้", "พับ", "ขยาย"]),
      group: "หัวข้อย่อย",
    },
    toggle_heading_3: {
      title: "หัวข้อแบบพับได้ 3",
      subtext: "หัวข้อส่วนย่อยและกลุ่มที่พับและขยายได้",
      aliases: thaiAliases(["h3", "heading3", "subheading", "collapsable"], ["หัวข้อ3", "พับได้", "พับ", "ขยาย"]),
      group: "หัวข้อย่อย",
    },
    quote: {
      title: "คำพูดอ้างอิง",
      subtext: "คำพูดอ้างอิงหรือข้อความที่ยกมา",
      aliases: thaiAliases(["quotation", "blockquote", "bq"], ["quote", "คำพูด", "อ้างอิง", "ยกข้อความ"]),
      group: "บล็อกพื้นฐาน",
    },
    toggle_list: {
      title: "รายการแบบพับได้",
      subtext: "รายการที่ซ่อนรายการย่อยได้",
      aliases: thaiAliases(["li", "list", "toggleList", "toggle list", "collapsable list"], ["รายการ", "รายการพับได้", "พับได้"]),
      group: "บล็อกพื้นฐาน",
    },
    numbered_list: {
      title: "รายการแบบมีเลขลำดับ",
      subtext: "รายการที่มีรายการเรียงลำดับ",
      aliases: thaiAliases(["ol", "li", "list", "numberedlist", "numbered list"], ["รายการ", "รายการมีเลข", "เลขลำดับ", "ลำดับเลข"]),
      group: "บล็อกพื้นฐาน",
    },
    bullet_list: {
      title: "รายการแบบสัญลักษณ์หัวข้อย่อย",
      subtext: "รายการที่มีรายการไม่เรียงลำดับ",
      aliases: thaiAliases(["ul", "li", "list", "bulletlist", "bullet list"], ["รายการ", "รายการสัญลักษณ์", "สัญลักษณ์หัวข้อย่อย", "จุด"]),
      group: "บล็อกพื้นฐาน",
    },
    check_list: {
      title: "รายการตรวจสอบ",
      subtext: "รายการที่มีช่องทำเครื่องหมาย",
      aliases: thaiAliases(["ul", "li", "list", "checklist", "check list", "checked list", "checkbox"], ["รายการ", "สิ่งที่ต้องทำ", "ช่องทำเครื่องหมาย", "งาน"]),
      group: "บล็อกพื้นฐาน",
    },
    paragraph: {
      title: "ย่อหน้า",
      subtext: "เนื้อหาหลักของเอกสาร",
      aliases: thaiAliases(["p", "paragraph"], ["ย่อหน้า", "ข้อความ"]),
      group: "บล็อกพื้นฐาน",
    },
    code_block: {
      title: "บล็อกโค้ด",
      subtext: "บล็อกโค้ดพร้อมการเน้นไวยากรณ์",
      aliases: thaiAliases(["code", "pre"], ["โค้ด", "บล็อกโค้ด"]),
      group: "บล็อกพื้นฐาน",
    },
    page_break: {
      title: "ตัวแบ่งหน้า",
      subtext: "ตัวแบ่งหน้า",
      aliases: thaiAliases(["page", "break", "separator"], ["ตัวแบ่งหน้า", "แบ่งหน้า", "ตัวคั่น"]),
      group: "บล็อกพื้นฐาน",
    },
    table: {
      title: "ตาราง",
      subtext: "ตารางที่มีเซลล์แก้ไขได้",
      aliases: thaiAliases(["table"], ["ตาราง"]),
      group: "ขั้นสูง",
    },
    image: {
      title: "รูปภาพ",
      subtext: "รูปภาพที่ปรับขนาดได้พร้อมคำอธิบาย",
      aliases: thaiAliases(["image", "imageUpload", "upload", "img", "picture", "media", "url"], ["รูปภาพ", "รูป", "ภาพ", "อัปโหลด", "สื่อ"]),
      group: "สื่อ",
    },
    video: {
      title: "วิดีโอ",
      subtext: "วิดีโอที่ปรับขนาดได้พร้อมคำอธิบาย",
      aliases: thaiAliases(["video", "videoUpload", "upload", "mp4", "film", "media", "url"], ["วิดีโอ", "หนัง", "อัปโหลด", "สื่อ"]),
      group: "สื่อ",
    },
    audio: {
      title: "เสียง",
      subtext: "เสียงที่ฝังไว้พร้อมคำอธิบาย",
      aliases: thaiAliases(["audio", "audioUpload", "upload", "mp3", "sound", "media", "url"], ["เสียง", "เพลง", "อัปโหลด", "สื่อ"]),
      group: "สื่อ",
    },
    file: {
      title: "ไฟล์",
      subtext: "ไฟล์ที่ฝังไว้",
      aliases: thaiAliases(["file", "upload", "embed", "media", "url"], ["ไฟล์", "อัปโหลด", "ฝัง", "สื่อ"]),
      group: "สื่อ",
    },
    emoji: {
      title: "อีโมจิ",
      subtext: "ค้นหาและแทรกอีโมจิ",
      aliases: thaiAliases(["emoji", "emote", "emotion", "face"], ["อีโมจิ", "อารมณ์", "หน้า"]),
      group: "อื่น ๆ",
    },
    divider: {
      title: "เส้นคั่น",
      subtext: "แบ่งบล็อกด้วยเส้นให้เห็นชัดเจน",
      aliases: thaiAliases(["divider", "hr", "line", "horizontal rule"], ["เส้นคั่น", "เส้น", "เส้นแนวนอน"]),
      group: "บล็อกพื้นฐาน",
    },
  },
  placeholders: {
    default: "เริ่มพิมพ์ หรือพิมพ์ '/' เพื่อดูคำสั่ง",
    heading: "หัวข้อ",
    toggleListItem: "รายการแบบพับได้",
    bulletListItem: "รายการ",
    numberedListItem: "รายการ",
    checkListItem: "รายการ",
    emptyDocument: undefined,
    new_comment: "เขียนความคิดเห็น...",
    edit_comment: "แก้ไขความคิดเห็น...",
    comment_reply: "เพิ่มความคิดเห็น...",
  } as Record<string, string | undefined>,
  file_blocks: {
    add_button_text: {
      image: "เพิ่มรูปภาพ",
      video: "เพิ่มวิดีโอ",
      audio: "เพิ่มเสียง",
      file: "เพิ่มไฟล์",
    } as Record<string, string>,
  },
  toggle_blocks: {
    add_block_button: "รายการแบบพับได้ที่ว่างเปล่า คลิกเพื่อเพิ่มบล็อก",
  },
  code_block: {
    add_source_button_text: "เพิ่มซอร์สโค้ด",
    ok_button_text: "ตกลง",
  },
  // from react package:
  side_menu: {
    add_block_label: "เพิ่มบล็อก",
    drag_handle_label: "เปิดเมนูบล็อก",
  },
  drag_handle: {
    delete_menuitem: "ลบ",
    colors_menuitem: "สี",
    header_row_menuitem: "แถวหัวตาราง",
    header_column_menuitem: "คอลัมน์หัวตาราง",
  },
  table_handle: {
    delete_column_menuitem: "ลบคอลัมน์",
    delete_row_menuitem: "ลบแถว",
    add_left_menuitem: "เพิ่มคอลัมน์ทางซ้าย",
    add_right_menuitem: "เพิ่มคอลัมน์ทางขวา",
    add_above_menuitem: "เพิ่มแถวด้านบน",
    add_below_menuitem: "เพิ่มแถวด้านล่าง",
    split_cell_menuitem: "แยกเซลล์",
    merge_cells_menuitem: "รวมเซลล์",
    background_color_menuitem: "สีพื้นหลัง",
  },
  suggestion_menu: {
    no_items_title: "ไม่พบผลลัพธ์",
  },
  color_picker: {
    text_title: "ข้อความ",
    background_title: "พื้นหลัง",
    colors: {
      default: "อัตโนมัติ",
      gray: "เทา",
      brown: "น้ำตาล",
      red: "แดง",
      orange: "ส้ม",
      yellow: "เหลือง",
      green: "เขียว",
      blue: "น้ำเงิน",
      purple: "ม่วง",
      pink: "ชมพู",
    },
  },

  formatting_toolbar: {
    bold: {
      tooltip: "ตัวหนา",
      secondary_tooltip: "Mod+B",
    },
    italic: {
      tooltip: "ตัวเอียง",
      secondary_tooltip: "Mod+I",
    },
    underline: {
      tooltip: "ขีดเส้นใต้",
      secondary_tooltip: "Mod+U",
    },
    strike: {
      tooltip: "ขีดฆ่า",
      secondary_tooltip: "Mod+Shift+S",
    },
    code: {
      tooltip: "โค้ด",
      secondary_tooltip: "",
    },
    colors: {
      tooltip: "สี",
    },
    link: {
      tooltip: "สร้างลิงก์",
      secondary_tooltip: "Mod+K",
    },
    file_caption: {
      tooltip: "แก้ไขคำอธิบาย",
      input_placeholder: "แก้ไขคำอธิบาย",
    },
    file_replace: {
      tooltip: {
        image: "เปลี่ยนรูปภาพ",
        video: "เปลี่ยนวิดีโอ",
        audio: "เปลี่ยนเสียง",
        file: "เปลี่ยนไฟล์",
      } as Record<string, string>,
    },
    file_rename: {
      tooltip: {
        image: "เปลี่ยนชื่อรูปภาพ",
        video: "เปลี่ยนชื่อวิดีโอ",
        audio: "เปลี่ยนชื่อเสียง",
        file: "เปลี่ยนชื่อไฟล์",
      } as Record<string, string>,
      input_placeholder: {
        image: "เปลี่ยนชื่อรูปภาพ",
        video: "เปลี่ยนชื่อวิดีโอ",
        audio: "เปลี่ยนชื่อเสียง",
        file: "เปลี่ยนชื่อไฟล์",
      } as Record<string, string>,
    },
    file_download: {
      tooltip: {
        image: "ดาวน์โหลดรูปภาพ",
        video: "ดาวน์โหลดวิดีโอ",
        audio: "ดาวน์โหลดเสียง",
        file: "ดาวน์โหลดไฟล์",
      } as Record<string, string>,
    },
    file_delete: {
      tooltip: {
        image: "ลบรูปภาพ",
        video: "ลบวิดีโอ",
        audio: "ลบเสียง",
        file: "ลบไฟล์",
      } as Record<string, string>,
    },
    file_preview_toggle: {
      tooltip: "สลับการแสดงตัวอย่าง",
    },
    nest: {
      tooltip: "เยื้องเข้า",
      secondary_tooltip: "Tab",
    },
    unnest: {
      tooltip: "เยื้องออก",
      secondary_tooltip: "Shift+Tab",
    },
    align_left: {
      tooltip: "จัดชิดซ้าย",
    },
    align_center: {
      tooltip: "จัดกึ่งกลาง",
    },
    align_right: {
      tooltip: "จัดชิดขวา",
    },
    align_justify: {
      tooltip: "จัดชิดสองข้าง",
    },
    table_cell_merge: {
      tooltip: "รวมเซลล์",
    },
    comment: {
      tooltip: "เพิ่มความคิดเห็น",
    },
  },
  file_panel: {
    upload: {
      title: "อัปโหลด",
      file_placeholder: {
        image: "อัปโหลดรูปภาพ",
        video: "อัปโหลดวิดีโอ",
        audio: "อัปโหลดเสียง",
        file: "อัปโหลดไฟล์",
      } as Record<string, string>,
      upload_error: "ข้อผิดพลาด: อัปโหลดไม่สำเร็จ",
    },
    embed: {
      title: "ฝัง",
      embed_button: {
        image: "ฝังรูปภาพ",
        video: "ฝังวิดีโอ",
        audio: "ฝังเสียง",
        file: "ฝังไฟล์",
      } as Record<string, string>,
      url_placeholder: "ป้อน URL",
    },
  },
  link_toolbar: {
    delete: {
      tooltip: "ลบลิงก์",
    },
    edit: {
      text: "แก้ไขลิงก์",
      tooltip: "แก้ไข",
    },
    open: {
      tooltip: "เปิดในแท็บใหม่",
    },
    form: {
      title_placeholder: "แก้ไขชื่อ",
      url_placeholder: "แก้ไข URL",
    },
  },
  comments: {
    edited: "แก้ไขแล้ว",
    save_button_text: "บันทึก",
    cancel_button_text: "ยกเลิก",
    deleted_reference_text: "เนื้อหาต้นฉบับถูกลบแล้ว",
    discard_pending_comment: "คุณแน่ใจหรือไม่ว่าต้องการทิ้งความคิดเห็นนี้",
    actions: {
      add_reaction: "เพิ่มปฏิกิริยา",
      resolve: "ทำเครื่องหมายว่าแก้ไขแล้ว",
      reopen: "เปิดใหม่",
      edit_comment: "แก้ไขความคิดเห็น",
      delete_comment: "ลบความคิดเห็น",
      more_actions: "การดำเนินการเพิ่มเติม",
    },
    reactions: {
      reacted_by: "ปฏิกิริยาโดย",
    },
    sidebar: {
      marked_as_resolved: "ทำเครื่องหมายว่าแก้ไขแล้ว",
      more_replies: (count: number) => `ตอบกลับอีก ${count} รายการ`,
    },
  },
  suggestion_changes: {
    formatting_change: "การเปลี่ยนรูปแบบ",
    deleted: "ลบแล้ว",
    inserted_by: (users: string) => `แทรกโดย ${users}`,
    deleted_by: (users: string) => `ลบโดย ${users}`,
    formatting_change_by: (formats: string, users: string) => `เปลี่ยนรูปแบบ (${formats}) โดย ${users}`,
  },
  exporter: {
    open_file: "เปิดไฟล์",
    open_video_file: "เปิดวิดีโอ",
    open_audio_file: "เปิดเสียง",
  },
  generic: {
    ctrl_shortcut: "Ctrl",
    form_submit: "ตกลง",
  },
};
