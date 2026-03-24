/**
 * @file src/utils/i18n.ts
 * @description Lightweight internationalisation (i18n) helper for ElastraX.
 *
 * Provides a single `t()` function that resolves a dot-separated translation key
 * to a localised string, with optional `{variable}` interpolation.
 *
 * Supported locales:
 *  - `en` — English (default)
 *  - `id` — Indonesian (Bahasa Indonesia)
 *
 * Adding a new locale:
 *  1. Add an entry to the `Locale` type union.
 *  2. Duplicate the `en` block in `translations` with the new locale key.
 *  3. Translate each string value.
 *
 * Adding a new translation key:
 *  1. Add the key/value to both `en` and `id` blocks.
 *  2. Call `t(lang, 'your.new.key')` in the appropriate module.
 *
 * Fallback behaviour:
 *  If the key does not exist in the requested locale, the `en` value is used.
 *  If the key does not exist in `en` either, a warning is logged and the raw key
 *  string is returned so UI output is still legible.
 */

/** Supported locale codes. */
type Locale = 'en' | 'id';

const translations: Record<Locale, Record<string, string>> = {
  en: {
    // Menu
    'menu.not_found': '❌ Command or tool "*{name}*" not found. Type /menu to see all commands.',
    'menu.help_for': '*Help for: /{name}*\n\n',
    'menu.description': '*Description:*',
    'menu.aliases': '*Aliases:*',
    'menu.category': '*Category:*',
    'menu.permissions': '*Permissions:*',
    'menu.usage': '*Usage:*',
    'menu.parameters': '*Parameters:*',
    'menu.param_type': 'Type:',
    'menu.options': 'Options:',
    'menu.required': 'Required',
    'menu.optional': 'Optional',
    'menu.greeting': 'Hello {name}!',
    'menu.hint': 'Use */help <command>* to see detailed usage of a command.\n\n',
    'menu.footer': '_Powered by ElastraX v7 with Native AI_',
    'menu.not_found_suggestion': '❌ Command or tool "*{name}*" not found. Did you mean "*{suggestion}*"?',

    // Group Admin
    'group.not_in_group': '❌ This command can only be used in a group.',
    'group.invalid_action': "❌ Invalid action. Must be one of: add, remove, promote, demote, mute, unmute, link.",
    'group.invalid_phone': '❌ Invalid user phone number.',
    'group.not_supported': '❌ Group Administration is not supported by the current adapter.',
    'group.success_add': '✅ Successfully added user {jid}.',
    'group.success_remove': '✅ Successfully removed user {jid}.',
    'group.error': '❌ Error administering group: {msg}. Note: Ensure the bot is an admin of the group.',

    // Sticker
    'sticker.no_media': '❌ I need an image or video to make a sticker! Please reply to an image/video or attach one.',
    'sticker.download_not_supported': '❌ Downloading media is not supported by the current adapter.',
    'sticker.download_failed': '❌ Failed to download the media.',
    'sticker.unsupported_type': '❌ Unsupported media type ({mime}). Please provide an image or short video.',
    'sticker.send_not_supported': '❌ Your current chat platform does not support sending stickers natively through the bot adapter.',
    'sticker.success': '✅ Sticker generated successfully!',
    'sticker.error': '❌ Error making sticker: {msg}',

    // Language
    'language.invalid': "❌ Invalid language code. Please provide either 'en' (English) or 'id' (Indonesian). Example: /language en",
    'language.success_id': '✅ Bahasa untuk obrolan ini telah diubah ke Bahasa Indonesia.',
    'language.success_en': '✅ The language for this chat room has been set to English.',
    'language.error': '❌ Error updating language: {msg}',

    // Flow
    'flow.cancelled': '❌ Active flow cancelled.',
    'flow.error': '❌ An error occurred processing your flow step:\n{msg}',

    // Agent
    'agent.no_permission': '⛔ You do not have permission to use this command.',
    'agent.unknown_command': 'Unknown command: /{cmd}',
    'agent.did_you_mean': 'Unknown command: /{cmd}. Did you mean */{suggestion}*?',
    'agent.internal_error': 'An internal error occurred while processing your message.',
    'agent.rate_limited': '⏳ Slow down! You can send a message every {seconds} seconds. Please wait.',

    // Ping
    'ping.response': '🏓 Pong!\n\n • ⏱ Latency: *{latency}ms*\n • ⬆️ Uptime: *{uptime}*',

    // ID
    'id.response': '🪪 *Your Info*\n\n • 👤 Name: *{name}*\n • 🆔 User ID: `{userId}`\n • 💬 Chat ID: `{chatId}`\n • 📡 Platform: *{platform}*\n • 🔑 Is Group: *{isGroup}*\n • 🔐 Permissions: *{permissions}*',

    // Stats
    'stats.response': '📊 *Room Statistics*\n\n • 💬 Total Messages: *{total}*\n • 🤖 Bot Replies: *{botReplies}*\n • 👤 Human Messages: *{humanMessages}*\n • 📅 Active Since: *{since}*\n • 🏆 Top User: *{topUser}* ({topCount} msgs)',
    'stats.no_data': '📊 No messages recorded for this room yet.',

    // Delete
    'delete.no_quoted': '❌ Please reply to one of my messages to delete it.',
    'delete.not_bot_message': '❌ I can only delete my own messages.',
    'delete.not_supported': '❌ Deleting messages is not supported on this platform.',
    'delete.success': '✅ Message deleted.',
    'delete.error': '❌ Failed to delete message: {msg}',

    // Translate
    'translate.no_text': '❌ Please provide text to translate or reply to a message.',
    'translate.success': '🌐 *Translation ({from} → {to}):*\n\n{result}',
    'translate.error': '❌ Translation failed: {msg}',

    // Download
    'download.no_url': '❌ Please provide a URL to download. Supported: YouTube, Instagram, TikTok, Twitter/X, and more.',
    'download.starting': '⬇️ Starting download...',
    'download.processing': '⚙️ Processing media...',
    'download.too_large': '❌ File too large to send ({size}MB). Maximum is {max}MB.',
    'download.success': '✅ Download complete!',
    'download.error': '❌ Download failed: {msg}',
    'download.not_supported': '❌ Sending media is not supported on this platform adapter.',
    'download.ytdlp_missing': '❌ yt-dlp is not installed. Ask the bot owner to install it.',

    // Media Convert
    'convert.no_media': '❌ Please attach or reply to a media file to convert.',
    'convert.unsupported': '❌ Unsupported conversion: {from} → {to}',
    'convert.starting': '⚙️ Converting media...',
    'convert.success': '✅ Conversion complete!',
    'convert.error': '❌ Conversion failed: {msg}',
    'convert.not_supported': '❌ Media sending is not supported on this platform.',

    // PDF
    'pdf.no_file': '❌ Please attach a PDF file or reply to one.',
    'pdf.not_pdf': '❌ The attachment must be a PDF file.',
    'pdf.download_failed': '❌ Failed to download the PDF.',
    'pdf.not_supported': '❌ PDF tools are not supported on this platform.',
    'pdf.success': '✅ PDF operation complete!',
    'pdf.error': '❌ PDF processing failed: {msg}',
    'pdf.info': '📄 *PDF Info*\nPages: *{pages}*\nSize: *{size}KB*',
    'pdf.already_optimized': 'This PDF is already well-optimized; no significant compression was possible.',
    'pdf.compress_done': '✅ PDF compressed: {from}KB → {to}KB (saved ~{pct}%)',
    'pdf.split_done': '✅ Extracted pages {start}–{end} ({pages} pages).',
    'pdf.rotate_done': '✅ All pages rotated {degrees}°.',
    'pdf.invalid_pages': '❌ No valid page numbers provided.',
    'pdf.cannot_remove_all': '❌ Cannot remove all pages from the PDF.',
    'pdf.remove_done': '✅ Removed {removed} page(s). {remaining} page(s) left.',
    'pdf.page_numbers_done': '✅ Page numbers added to {pages} pages.',
    'pdf.watermark_done': '✅ Watermark applied to all pages.',
    'pdf.no_text': '❌ No extractable text found in this PDF.',
    'pdf.no_forms': 'This PDF has no form fields to flatten.',
    'pdf.flatten_done': '✅ Form fields flattened.',
    'pdf.metadata_missing': '❌ Provide at least one of: title, author, or subject.',
    'pdf.metadata_done': '✅ PDF metadata updated.',
    'pdf.merge_done': '✅ PDFs merged ({pages} pages total).',
    'pdf.merge_need_two': '❌ Send two PDFs: quote one and attach another, or start a collection.',
    'pdf.merge_collect_started': '📎 *Merge mode started!*\nSend PDF files one by one.\nType *done* when finished.',
    'pdf.merge_collect_started_one': '📎 *Merge mode started!* (1 PDF received)\nSend more PDF files.\nType *done* when finished.',
    'pdf.merge_collect_added': '📄 PDF #{count} received. Send more or type *done*.',
    'pdf.merge_collect_hint': '📎 Send a PDF file ({count} collected so far). Type *done* to merge, or /cancel to abort.',
    'pdf.merge_collect_need_more': '❌ Need at least 2 PDFs to merge ({count} so far). Send more files.',
    'pdf.img_to_pdf_done': '✅ Image(s) converted to PDF ({pages} page(s)).',
    'pdf.no_image': '❌ Please attach a JPEG or PNG image.',
    'pdf.not_image': '❌ The attachment must be a JPEG or PNG image.',
    'pdf.img_collect_started': '🖼️ *Image-to-PDF mode started!*\nSend images (JPEG/PNG) one by one.\nType *done* when finished.',
    'pdf.img_collect_added': '🖼️ Image #{count} received. Send more or type *done*.',
    'pdf.img_collect_hint': '🖼️ Send a JPEG/PNG image ({count} collected so far). Type *done* to convert, or /cancel to abort.',
    'pdf.img_collect_empty': '❌ No images received yet. Send at least one image first.',
    'pdf.collect_max': '❌ Maximum {max} files reached. Type *done* to process.',

    // Group Management (expanded)
    'group.promote_success': '✅ {jid} has been promoted to admin.',
    'group.demote_success': '✅ {jid} has been demoted from admin.',
    'group.mute_success': '✅ Group has been {status}.',
    'group.link_success': '🔗 Group invite link:\n{link}',
    'group.link_not_supported': '❌ Getting the group invite link is not supported.',
    'group.invalid_admin_action': "❌ Invalid action. Must be 'promote' or 'demote'.",

    // Reminders
    'reminder.set': '⏰ Reminder set! I will remind you on *{time}* with:\n_{message}_',
    'reminder.invalid_time': '❌ Could not understand the time. Try "in 30 minutes", "tomorrow at 3pm", or a specific time.',
    'reminder.no_message': '❌ Please provide what I should remind you about.',
    'reminder.fired': '⏰ *Reminder for {name}:*\n\n{message}',
    'reminder.list_empty': '📭 You have no active reminders.',
    'reminder.list': '⏰ *Your reminders:*\n{items}',
    'reminder.list_item': '{n}. _{message}_ — *{time}*',
    'reminder.cancel': '✅ Reminder #{n} cancelled.',
    'reminder.cancel_invalid': '❌ Invalid reminder number.',
    'reminder.error': '❌ Failed to set reminder: {msg}',

    // Voice Transcription
    'transcribe.starting': '🎤 Transcribing voice note...',
    'transcribe.not_supported': '❌ Voice transcription endpoint is not configured.',
    'transcribe.error': '❌ Transcription failed: {msg}',
    'transcribe.result': '🎤 *Voice note transcript:*\n\n{text}',

    // Webhook Server
    'webhook.missing_secret': '❌ Webhook secret is missing or invalid.',

    // Menfess
    'menfess.no_target': '❌ Please specify the target group/chat ID.',
    'menfess.no_message': '❌ Please provide a message to send anonymously.',
    'menfess.preview': '📬 *Anonymous message preview:*\n\n_{message}_\n\nReply *yes* to send or *no* to cancel.',
    'menfess.sent': '✅ Anonymous message sent!',
    'menfess.cancelled': '❌ Menfess cancelled.',
    'menfess.not_supported': '❌ Forwarding to another chat is not supported on this platform.',
    'menfess.error': '❌ Failed to send menfess: {msg}',

    // Role Management
    'role.check': '🔐 *Role info for* {userTag}\n\n*Effective roles:* *{effectiveRole}*\n\n*Assigned roles:*\n\n{roles}',
    'role.list': '📋 *Roles for {scope}:*\n\n{items}',
    'role.list_empty': '📋 No roles assigned for *{scope}*.',
    'role.granted': '✅ Granted *{role}* role to {userTag} in *{scope}*.',
    'role.revoked': '✅ Revoked role from {userTag} in *{scope}*.',
    'role.no_user': '❌ Please specify a user. Example: `/role grant 628xxx admin`',
    'role.invalid_role': "❌ Invalid role. Must be `user`, `premium`, `admin`, or `owner`.",
    'role.insufficient': '⛔ You ({callerRole}) cannot assign/revoke the *{targetRole}* role.',
    'role.usage': '❓ *Usage:*\n\n • `/role check [user]` — Check roles & privileges\n • `/role grant <user> <role> [global]` — Assign role\n • `/role revoke <user> <role> [global]` — Remove role\n • `/role list [global]` — List assigned roles\n • `/role privs <role>` — View privileges\n • `/role setpriv <role> <field> <value>` — Override privilege (owner)\n • `/role resetpriv <role>` — Reset to defaults (owner)',

    // Owner Admin
    'owner.broadcast_no_message': '❌ Please provide a broadcast message.',
    'owner.broadcast_no_rooms': '❌ No rooms found on this platform.',
    'owner.broadcast_done': '📢 Broadcast complete! Sent to *{sent}* rooms ({failed} failed out of {total}).',
    'owner.leave_not_group': '❌ This command can only be used in a group.',
    'owner.leave_goodbye': '👋 Goodbye! ElastraX is leaving this group.',
    'owner.leave_not_supported': '❌ Leaving groups is not supported on this platform.',
    'owner.leave_error': '❌ Failed to leave group: {msg}',
    'owner.usage': '❓ *Owner Commands:*\n\n • `/broadcast <message>` — Send to all rooms\n • `/leave` — Leave current group\n • `/owner system_info` — Bot stats',

    // Recurring Reminders
    'reminder.recurrence_set': '🔁 Recurring reminder set ({recurrence})! Next fire: *{time}*\n_{message}_',
    'reminder.recurrence_info': ' 🔁 _{recurrence}_',
  },
  id: {
    // Menu
    'menu.not_found': '❌ Perintah atau alat "*{name}*" tidak ditemukan. Ketik /menu untuk melihat semua perintah.',
    'menu.help_for': '*Bantuan untuk: /{name}*\n\n',
    'menu.description': '*Deskripsi:*',
    'menu.aliases': '*Alias:*',
    'menu.category': '*Kategori:*',
    'menu.permissions': '*Izin:*',
    'menu.usage': '*Penggunaan:*',
    'menu.parameters': '*Parameter:*',
    'menu.param_type': 'Tipe:',
    'menu.options': 'Opsi:',
    'menu.required': 'Wajib',
    'menu.optional': 'Opsional',
    'menu.greeting': 'Halo {name}!',
    'menu.hint': 'Gunakan */help <command>* untuk melihat detail cara menggunakan sebuah command.\n\n',
    'menu.footer': '_Powered by ElastraX v7 with Native AI_',
    'menu.not_found_suggestion': '❌ Perintah atau alat "*{name}*" tidak ditemukan. Maksud Anda "*{suggestion}*"?',

    // Group Admin
    'group.not_in_group': '❌ Perintah ini hanya dapat digunakan di dalam grup.',
    'group.invalid_action': "❌ Tindakan tidak valid. Harus salah satu: add, remove, promote, demote, mute, unmute, link.",
    'group.invalid_phone': '❌ Nomor telepon pengguna tidak valid.',
    'group.not_supported': '❌ Administrasi Grup tidak didukung oleh adaptor saat ini.',
    'group.success_add': '✅ Berhasil menambahkan pengguna {jid}.',
    'group.success_remove': '✅ Berhasil menghapus pengguna {jid}.',
    'group.error': '❌ Gagal mengelola grup: {msg}. Catatan: Pastikan bot adalah admin grup.',

    // Sticker
    'sticker.no_media': '❌ Saya butuh gambar atau video untuk membuat stiker! Balas gambar/video atau lampirkan satu.',
    'sticker.download_not_supported': '❌ Mengunduh media tidak didukung oleh adaptor saat ini.',
    'sticker.download_failed': '❌ Gagal mengunduh media.',
    'sticker.unsupported_type': '❌ Jenis media tidak didukung ({mime}). Harap berikan gambar atau video pendek.',
    'sticker.send_not_supported': '❌ Platform chat Anda tidak mendukung pengiriman stiker secara native melalui adaptor bot.',
    'sticker.success': '✅ Stiker berhasil dibuat!',
    'sticker.error': '❌ Gagal membuat stiker: {msg}',

    // Language
    'language.invalid': "❌ Kode bahasa tidak valid. Harap berikan 'en' (Inggris) atau 'id' (Indonesia). Contoh: /language id",
    'language.success_id': '✅ Bahasa untuk obrolan ini telah diubah ke Bahasa Indonesia.',
    'language.success_en': '✅ Bahasa untuk obrolan ini telah diatur ke Bahasa Inggris.',
    'language.error': '❌ Gagal memperbarui bahasa: {msg}',

    // Flow
    'flow.cancelled': '❌ Sesi aktif dibatalkan.',
    'flow.error': '❌ Terjadi kesalahan saat memproses langkah alur Anda:\n{msg}',

    // Agent
    'agent.no_permission': '⛔ Anda tidak memiliki izin untuk menggunakan perintah ini.',
    'agent.unknown_command': 'Perintah tidak dikenal: /{cmd}',
    'agent.did_you_mean': 'Perintah tidak dikenal: /{cmd}. Maksud Anda */{suggestion}*?',
    'agent.internal_error': 'Terjadi kesalahan internal saat memproses pesan Anda.',
    'agent.rate_limited': '⏳ Pelan-pelan ya! Kamu bisa kirim pesan setiap {seconds} detik. Tunggu dulu.',

    // Ping
    'ping.response': '🏓 Pong!\n\n • ⏱ Latensi: *{latency}ms*\n • ⬆️ Uptime: *{uptime}*',

    // ID
    'id.response': '🪪 *Info Kamu*\n\n • 👤 Nama: *{name}*\n • 🆔 User ID: `{userId}`\n • 💬 Chat ID: `{chatId}`\n • 📡 Platform: *{platform}*\n • 🔑 Grup: *{isGroup}*\n • 🔐 Izin: *{permissions}*',

    // Stats
    'stats.response': '📊 *Statistik Ruangan*\n\n • 💬 Total Pesan: *{total}*\n • 🤖 Balasan Bot: *{botReplies}*\n • 👤 Pesan Manusia: *{humanMessages}*\n • 📅 Aktif Sejak: *{since}*\n • 🏆 Pengguna Aktif: *{topUser}* ({topCount} pesan)',
    'stats.no_data': '📊 Belum ada pesan yang tercatat untuk ruangan ini.',

    // Delete
    'delete.no_quoted': '❌ Balas salah satu pesan saya untuk menghapusnya.',
    'delete.not_bot_message': '❌ Saya hanya bisa menghapus pesan saya sendiri.',
    'delete.not_supported': '❌ Menghapus pesan tidak didukung di platform ini.',
    'delete.success': '✅ Pesan berhasil dihapus.',
    'delete.error': '❌ Gagal menghapus pesan: {msg}',

    // Translate
    'translate.no_text': '❌ Berikan teks untuk diterjemahkan atau balas pesan.',
    'translate.success': '🌐 *Terjemahan ({from} → {to}):*\n\n{result}',
    'translate.error': '❌ Terjemahan gagal: {msg}',

    // Download
    'download.no_url': '❌ Harap berikan URL untuk diunduh. Didukung: YouTube, Instagram, TikTok, Twitter/X, dan lainnya.',
    'download.starting': '⬇️ Memulai unduhan...',
    'download.processing': '⚙️ Memproses media...',
    'download.too_large': '❌ File terlalu besar untuk dikirim ({size}MB). Maksimal {max}MB.',
    'download.success': '✅ Unduhan selesai!',
    'download.error': '❌ Unduhan gagal: {msg}',
    'download.not_supported': '❌ Pengiriman media tidak didukung oleh adaptor platform ini.',
    'download.ytdlp_missing': '❌ yt-dlp tidak terpasang. Minta pemilik bot untuk memasangnya.',

    // Media Convert
    'convert.no_media': '❌ Lampirkan atau balas file media untuk dikonversi.',
    'convert.unsupported': '❌ Konversi tidak didukung: {from} → {to}',
    'convert.starting': '⚙️ Mengonversi media...',
    'convert.success': '✅ Konversi selesai!',
    'convert.error': '❌ Konversi gagal: {msg}',
    'convert.not_supported': '❌ Pengiriman media tidak didukung di platform ini.',

    // PDF
    'pdf.no_file': '❌ Lampirkan atau balas file PDF.',
    'pdf.not_pdf': '❌ Lampiran harus berupa file PDF.',
    'pdf.download_failed': '❌ Gagal mengunduh PDF.',
    'pdf.not_supported': '❌ Alat PDF tidak didukung di platform ini.',
    'pdf.success': '✅ Operasi PDF selesai!',
    'pdf.error': '❌ Pemrosesan PDF gagal: {msg}',
    'pdf.info': '📄 *Info PDF*\nHalaman: *{pages}*\nUkuran: *{size}KB*',
    'pdf.already_optimized': 'PDF ini sudah optimal; kompresi signifikan tidak memungkinkan.',
    'pdf.compress_done': '✅ PDF dikompresi: {from}KB → {to}KB (hemat ~{pct}%)',
    'pdf.split_done': '✅ Halaman {start}–{end} diekstrak ({pages} halaman).',
    'pdf.rotate_done': '✅ Semua halaman diputar {degrees}°.',
    'pdf.invalid_pages': '❌ Nomor halaman tidak valid.',
    'pdf.cannot_remove_all': '❌ Tidak bisa menghapus semua halaman.',
    'pdf.remove_done': '✅ {removed} halaman dihapus. Sisa {remaining} halaman.',
    'pdf.page_numbers_done': '✅ Nomor halaman ditambahkan ke {pages} halaman.',
    'pdf.watermark_done': '✅ Watermark diterapkan ke semua halaman.',
    'pdf.no_text': '❌ Tidak ada teks yang bisa diekstrak dari PDF ini.',
    'pdf.no_forms': 'PDF ini tidak memiliki form fields untuk di-flatten.',
    'pdf.flatten_done': '✅ Form fields di-flatten.',
    'pdf.metadata_missing': '❌ Sertakan minimal satu: title, author, atau subject.',
    'pdf.metadata_done': '✅ Metadata PDF diperbarui.',
    'pdf.merge_done': '✅ PDF digabung ({pages} halaman total).',
    'pdf.merge_need_two': '❌ Kirim dua PDF: balas satu dan lampirkan yang lain, atau mulai koleksi.',
    'pdf.merge_collect_started': '📎 *Mode gabung dimulai!*\nKirim file PDF satu per satu.\nKetik *done* jika selesai.',
    'pdf.merge_collect_started_one': '📎 *Mode gabung dimulai!* (1 PDF diterima)\nKirim file PDF lainnya.\nKetik *done* jika selesai.',
    'pdf.merge_collect_added': '📄 PDF #{count} diterima. Kirim lagi atau ketik *done*.',
    'pdf.merge_collect_hint': '📎 Kirim file PDF ({count} terkumpul). Ketik *done* untuk gabung, atau /cancel untuk batal.',
    'pdf.merge_collect_need_more': '❌ Minimal 2 PDF untuk digabung ({count} sejauh ini). Kirim lagi.',
    'pdf.img_to_pdf_done': '✅ Gambar dikonversi ke PDF ({pages} halaman).',
    'pdf.no_image': '❌ Lampirkan gambar JPEG atau PNG.',
    'pdf.not_image': '❌ Lampiran harus berupa gambar JPEG atau PNG.',
    'pdf.img_collect_started': '🖼️ *Mode gambar-ke-PDF dimulai!*\nKirim gambar (JPEG/PNG) satu per satu.\nKetik *done* jika selesai.',
    'pdf.img_collect_added': '🖼️ Gambar #{count} diterima. Kirim lagi atau ketik *done*.',
    'pdf.img_collect_hint': '🖼️ Kirim gambar JPEG/PNG ({count} terkumpul). Ketik *done* untuk konversi, atau /cancel untuk batal.',
    'pdf.img_collect_empty': '❌ Belum ada gambar yang diterima. Kirim minimal satu gambar dulu.',
    'pdf.collect_max': '❌ Maksimal {max} file tercapai. Ketik *done* untuk proses.',

    // Group Management (expanded)
    'group.promote_success': '✅ {jid} telah dipromosikan menjadi admin.',
    'group.demote_success': '✅ {jid} telah diturunkan dari admin.',
    'group.mute_success': '✅ Grup telah {status}.',
    'group.link_success': '🔗 Link undangan grup:\n{link}',
    'group.link_not_supported': '❌ Mendapatkan link grup tidak didukung.',
    'group.invalid_admin_action': "❌ Tindakan tidak valid. Harus 'promote' atau 'demote'.",

    // Reminders
    'reminder.set': '⏰ Pengingat diatur! Saya akan mengingatkanmu pada *{time}*:\n_{message}_',
    'reminder.invalid_time': '❌ Tidak bisa memahami waktunya. Coba "dalam 30 menit", "besok jam 3 sore", atau waktu spesifik.',
    'reminder.no_message': '❌ Tolong berikan isi pengingatnya.',
    'reminder.fired': '⏰ *Pengingat untuk {name}:*\n\n{message}',
    'reminder.list_empty': '📭 Kamu tidak punya pengingat aktif.',
    'reminder.list': '⏰ *Pengingatmu:*\n{items}',
    'reminder.list_item': '{n}. _{message}_ — *{time}*',
    'reminder.cancel': '✅ Pengingat #{n} dibatalkan.',
    'reminder.cancel_invalid': '❌ Nomor pengingat tidak valid.',
    'reminder.error': '❌ Gagal mengatur pengingat: {msg}',

    // Voice Transcription
    'transcribe.starting': '🎤 Mentranskrip pesan suara...',
    'transcribe.not_supported': '❌ Endpoint transkripsi suara belum dikonfigurasi.',
    'transcribe.error': '❌ Transkripsi gagal: {msg}',
    'transcribe.result': '🎤 *Transkripsi pesan suara:*\n\n{text}',

    // Webhook Server
    'webhook.missing_secret': '❌ Webhook secret tidak ada atau tidak valid.',

    // Menfess
    'menfess.no_target': '❌ Harap tentukan ID grup/chat tujuan.',
    'menfess.no_message': '❌ Harap berikan pesan yang akan dikirim secara anonim.',
    'menfess.preview': '📬 *Pratinjau pesan anonim:*\n\n_{message}_\n\nBalas *ya* untuk mengirim atau *tidak* untuk membatalkan.',
    'menfess.sent': '✅ Pesan anonim terkirim!',
    'menfess.cancelled': '❌ Menfess dibatalkan.',
    'menfess.not_supported': '❌ Penerusan pesan ke chat lain tidak didukung di platform ini.',
    'menfess.error': '❌ Gagal mengirim menfess: {msg}',

    // Role Management
    'role.check': '🔐 *Info role untuk* {userTag}\n\n*Role efektif:* *{effectiveRole}*\n\n*Role yang ditetapkan:*\n\n{roles}',
    'role.list': '📋 *Role untuk {scope}:*\n\n{items}',
    'role.list_empty': '📋 Belum ada role yang ditetapkan untuk *{scope}*.',
    'role.granted': '✅ Role *{role}* diberikan ke {userTag} di *{scope}*.',
    'role.revoked': '✅ Role dicabut dari {userTag} di *{scope}*.',
    'role.no_user': '❌ Harap tentukan pengguna. Contoh: `/role grant 628xxx admin`',
    'role.invalid_role': "❌ Role tidak valid. Harus `user`, `premium`, `admin`, atau `owner`.",
    'role.insufficient': '⛔ Anda ({callerRole}) tidak bisa menetapkan/mencabut role *{targetRole}*.',
    'role.usage': '❓ *Cara pakai:*\n\n • `/role check [user]` — Cek role & hak akses\n • `/role grant <user> <role> [global]` — Tetapkan role\n • `/role revoke <user> <role> [global]` — Cabut role\n • `/role list [global]` — Daftar role\n • `/role privs <role>` — Lihat hak akses\n • `/role setpriv <role> <field> <value>` — Ubah hak akses (owner)\n • `/role resetpriv <role>` — Reset ke default (owner)',

    // Owner Admin
    'owner.broadcast_no_message': '❌ Harap berikan pesan untuk disiarkan.',
    'owner.broadcast_no_rooms': '❌ Tidak ada ruangan ditemukan di platform ini.',
    'owner.broadcast_done': '📢 Siaran selesai! Terkirim ke *{sent}* ruangan ({failed} gagal dari {total}).',
    'owner.leave_not_group': '❌ Perintah ini hanya bisa digunakan di dalam grup.',
    'owner.leave_goodbye': '👋 Selamat tinggal! ElastraX meninggalkan grup ini.',
    'owner.leave_not_supported': '❌ Keluar dari grup tidak didukung di platform ini.',
    'owner.leave_error': '❌ Gagal meninggalkan grup: {msg}',
    'owner.usage': '❓ *Perintah Owner:*\n\n • `/broadcast <pesan>` — Kirim ke semua ruangan\n • `/leave` — Keluar dari grup\n • `/owner system_info` — Info bot',

    // Recurring Reminders
    'reminder.recurrence_set': '🔁 Pengingat berulang diatur ({recurrence})! Berikutnya: *{time}*\n_{message}_',
    'reminder.recurrence_info': ' 🔁 _{recurrence}_',
  },
};

/**
 * Translate a key to the given locale, with optional variable interpolation.
 * Falls back to 'en' if the key is missing in the requested locale.
 * @param lang - Language code ('en' | 'id'). Defaults to 'en' for unknown values.
 * @param key  - Translation key (e.g. 'menu.greeting')
 * @param vars - Optional map of {variable} placeholders to replace in the string
 */
export function t(lang: string | undefined, key: string, vars: Record<string, string> = {}): string {
  const locale: Locale = lang === 'id' ? 'id' : 'en';
  let str = translations[locale][key] ?? translations.en[key];
  if (str === undefined) {
    console.warn(`[i18n] Missing translation key: "${key}" for locale "${locale}"`);
    str = key;
  }
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, v);
  }
  return str;
}
