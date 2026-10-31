// PDF生成（ライブラリなし・端末内）。OCR結果があれば透明テキストを重ねて、文字検索できるPDFにする。

const enc = new TextEncoder();

// 文字をIdentity-Hの2バイトコード（=UTF-16のコード単位）に変換。BMP外の文字は〓にする
function hexText(s) {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const code = cp > 0xffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0x3013 : cp;
    out += code.toString(16).padStart(4, '0');
  }
  return out;
}

// CID → Unicode の対応表（CID = Unicodeのコード値）
function toUnicodeCMap() {
  const ranges = [];
  for (let hi = 0; hi < 256; hi++) {
    if (hi >= 0xd8 && hi <= 0xdf) continue;
    const h = hi.toString(16).padStart(2, '0');
    ranges.push(`<${h}00> <${h}ff> <${h}00>`);
  }
  let body = '';
  for (let i = 0; i < ranges.length; i += 100) {
    const chunk = ranges.slice(i, i + 100);
    body += `${chunk.length} beginbfrange\n${chunk.join('\n')}\nendbfrange\n`;
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

// OCRの行を、画像上の位置に合わせた透明テキスト（描画モード3）にする
function textLayer(ocr, k, pageH) {
  if (!ocr || !ocr.lines || !ocr.lines.length) return '';
  let s = 'BT 3 Tr\n';
  for (const { text, bbox } of ocr.lines) {
    const chars = [...text];
    if (!chars.length) continue;
    const x = bbox.x0 * k, w = (bbox.x1 - bbox.x0) * k, h = (bbox.y1 - bbox.y0) * k;
    if (w <= 0 || h <= 0) continue;
    const vertical = chars.length > 1 && h > w * 1.6;
    if (vertical) {
      // 縦書き: 1文字ずつ上から並べる
      const step = h / chars.length, fs = Math.min(w, step);
      chars.forEach((c, i) => {
        const y = pageH - bbox.y0 * k - step * (i + 1) + step * 0.15;
        s += `/F1 ${fs.toFixed(2)} Tf 100 Tz 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hexText(c)}> Tj\n`;
      });
    } else {
      const fs = h, tz = Math.max(1, Math.min(1000, 100 * w / (chars.length * fs)));
      const y = pageH - bbox.y1 * k + h * 0.15;
      s += `/F1 ${fs.toFixed(2)} Tf ${tz.toFixed(1)} Tz 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hexText(text)}> Tj\n`;
    }
  }
  return s + 'ET\n';
}

// list: [{ blob(JPEG), width, height, ocr? }]  ocrの座標は ocr.width/ocr.height の画像基準
export async function buildPdf(list, title = '') {
  const parts = [], offsets = [];
  let offset = 0;
  const push = d => { const b = typeof d === 'string' ? enc.encode(d) : d; parts.push(b); offset += b.length; };
  const obj = (id, write) => { offsets[id] = offset; push(`${id} 0 obj\n`); write(); push('\nendobj\n'); };
  const stream = (dict, data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    push(`<< ${dict} /Length ${bytes.length} >>\nstream\n`); push(bytes); push('\nendstream');
  };

  // 1:カタログ 2:ページ一覧 3:フォント 4:CIDフォント 5:ToUnicode 6:フォント記述 7:情報  8〜:各ページ(3つずつ)
  const FIRST = 8, pageIds = list.map((_, i) => FIRST + i * 3);
  const hasText = list.some(p => p.ocr && p.ocr.lines && p.ocr.lines.length);
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => push(`<< /Type /Pages /Count ${list.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`));
  obj(3, () => push('<< /Type /Font /Subtype /Type0 /BaseFont /ScanLiteOCR /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>'));
  obj(4, () => push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ScanLiteOCR /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 1000 /CIDToGIDMap /Identity >>'));
  obj(5, () => stream('', toUnicodeCMap()));
  obj(6, () => push('<< /Type /FontDescriptor /FontName /ScanLiteOCR /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>'));
  // タイトルはUTF-16BEで入れる
  let t16 = 'feff';
  for (let i = 0; i < title.length; i++) t16 += title.charCodeAt(i).toString(16).padStart(4, '0');
  obj(7, () => push(`<< /Title <${t16}> /Producer (ScanLite) >>`));

  for (let i = 0; i < list.length; i++) {
    const p = list[i], id = pageIds[i];
    const bytes = new Uint8Array(await p.blob.arrayBuffer());
    const k = 842 / Math.max(p.width, p.height); // 長辺をA4長辺（842pt）に合わせる
    const W = p.width * k, H = p.height * k;
    const ocrK = p.ocr ? W / p.ocr.width : 0;
    const content = `q ${W.toFixed(2)} 0 0 ${H.toFixed(2)} 0 0 cm /Im0 Do Q\n` + (p.ocr ? textLayer(p.ocr, ocrK, H) : '');
    const fonts = hasText ? ' /Font << /F1 3 0 R >>' : '';
    obj(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /XObject << /Im0 ${id + 2} 0 R >>${fonts} >> /Contents ${id + 1} 0 R >>`));
    obj(id + 1, () => stream('', content));
    obj(id + 2, () => stream(`/Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, bytes));
  }
  const size = FIRST + list.length * 3;
  const xref = offset;
  let table = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
