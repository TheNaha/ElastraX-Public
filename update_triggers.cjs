const fs = require('fs');

const updates = [
  {
    file: 'src/tools/DownloadTool.ts',
    search: 'override readonly triggerPatterns = [/https?:\\/\\//i];',
    replace: 'override readonly triggerPatterns = [/https?:\\/\\//i, /\\b(download|unduh|save|simpan)\\b/i];'
  },
  {
    file: 'src/tools/MakeStickerTool.ts',
    search: 'override readonly triggerPatterns = [/^image\\//i, /^video\\//i];',
    replace: 'override readonly triggerPatterns = [/^image\\//i, /^video\\//i, /\\b(sticker|stiker)\\b/i];'
  },
  {
    file: 'src/tools/MediaConvertTool.ts',
    search: 'override readonly triggerPatterns = [/^image\\//i, /^video\\//i, /^audio\\//i];',
    replace: 'override readonly triggerPatterns = [/^image\\//i, /^video\\//i, /^audio\\//i, /\\b(convert|konversi|ubah|change format)\\b/i];'
  },
  {
    file: 'src/tools/MediaSearchTool.ts',
    search: '/\\b(search|find|looking for|want to watch|is .+ available|movie|film|tv show|series|anime|trending|recommend)\\b/i,',
    replace: '/\\b(search|find|looking for|want to watch|is .+ available|movie|film|tv show|series|anime|trending|recommend|cari|nonton|rekomendasi)\\b/i,'
  },
  {
    file: 'src/tools/PDFTool.ts',
    search: 'override readonly triggerPatterns = [/application\\/pdf/i, /\\bpdf\\b/i];',
    replace: 'override readonly triggerPatterns = [/application\\/pdf/i, /\\b(pdf|merge|gabung|gambar ke pdf)\\b/i];'
  },
  {
    file: 'src/tools/TranscribeTool.ts',
    search: 'override readonly triggerPatterns = [/^audio\\//i];',
    replace: 'override readonly triggerPatterns = [/^audio\\//i, /\\b(transcribe|transkrip|what did they say|apa yang dia bilang)\\b/i];'
  },
  {
    file: 'src/tools/TranslateTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(translate|terjemahkan|artikan|meaning|apa artinya)\\b/i];"
  },
  {
    file: 'src/tools/ReminderTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(remind|ingatkan|reminder|alarm|timer|waktu)\\b/i];"
  },
  {
    file: 'src/tools/DeleteMessageTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(delete|hapus|tarik|unsend|remove)\\b/i];"
  },
  {
    file: 'src/tools/GroupAdminTool.ts',
    search: "readonly permissions = 'admin';",
    replace: "readonly permissions = 'admin';\n  override readonly triggerPatterns = [/\\b(kick|ban|promote|demote|keluarkan|jadikan admin|turunkan)\\b/i];"
  },
  {
    file: 'src/tools/LanguageTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(language|bahasa|ganti bahasa|change language)\\b/i];"
  },
  {
    file: 'src/tools/PingTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(ping|lag|latency|koneksi)\\b/i];"
  },
  {
    file: 'src/tools/MenfessTool.ts',
    search: "readonly permissions = 'user';",
    replace: "readonly permissions = 'user';\n  override readonly triggerPatterns = [/\\b(menfess|confess|rahasia|anonymous)\\b/i];"
  }
];

updates.forEach(u => {
  let content = fs.readFileSync(u.file, 'utf-8');
  if (content.includes(u.search)) {
    content = content.replace(u.search, u.replace);
    fs.writeFileSync(u.file, content);
    console.log(`Updated ${u.file}`);
  } else {
    console.log(`Could not find search string in ${u.file}`);
  }
});
