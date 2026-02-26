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
    'menu.greeting': 'Hello {name}!',
    'menu.hint': 'Use */help <command>* to see detailed usage of a command.\n\n',
    'menu.footer': '_Powered by ElastraX v7 with Native AI_',

    // Group Admin
    'group.not_in_group': '❌ This command can only be used in a group.',
    'group.invalid_action': "❌ Invalid action. Must be 'add' or 'remove'.",
    'group.invalid_phone': '❌ Invalid user phone number.',
    'group.not_supported': '❌ Group Administration is not supported by the current adapter.',
    'group.success_add': '✅ Successfully Added user {jid}.',
    'group.success_remove': '✅ Successfully Removed user {jid}.',
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
    'agent.internal_error': 'An internal error occurred while processing your message.',
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
    'menu.greeting': 'Halo {name}!',
    'menu.hint': 'Gunakan */help <command>* untuk melihat detail cara menggunakan sebuah command.\n\n',
    'menu.footer': '_Powered by ElastraX v7 with Native AI_',

    // Group Admin
    'group.not_in_group': '❌ Perintah ini hanya dapat digunakan di dalam grup.',
    'group.invalid_action': "❌ Tindakan tidak valid. Harus 'add' atau 'remove'.",
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
    'agent.internal_error': 'Terjadi kesalahan internal saat memproses pesan Anda.',
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
