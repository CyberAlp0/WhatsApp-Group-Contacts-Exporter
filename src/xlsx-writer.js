/*
 * Minimal, dependency-free XLSX writer.
 * Produces a valid Office Open XML workbook (stored / uncompressed ZIP)
 * with one or more sheets, bold header row, frozen header, autofilter and column widths.
 *
 * Usage:
 *   const blob = WAGX_XLSX.build([{ name: 'Contacts', rows: [[...header], [...row]], widths: [12, 20] }]);
 */
(function (global) {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- ZIP (store only) ----------
  function zip(files) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true); // version needed
      local.setUint16(6, 0x0800, true); // UTF-8 names
      local.setUint16(8, 0, true); // method: store
      local.setUint16(10, 0, true); // time
      local.setUint16(12, 0x21, true); // date (1980-01-01)
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(new Uint8Array(local.buffer), nameBytes, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 0x21, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBytes.length, true);
      cd.setUint16(30, 0, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }

  // ---------- XML helpers ----------
  // Strip characters that are illegal in XML 1.0 (keeps emoji / Arabic intact).
  const ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  function esc(v) {
    return String(v)
      .replace(ILLEGAL, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(i) {
    let s = '';
    i++;
    while (i > 0) {
      const m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function sanitizeSheetName(name, used) {
    let n = String(name || 'Sheet').replace(/[\\\/\?\*\[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let base = n, k = 2;
    while (used.has(n.toLowerCase())) {
      const suffix = ` (${k++})`;
      n = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(n.toLowerCase());
    return n;
  }

  function sheetXml(rows, widths) {
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
    out.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    if (widths && widths.length) {
      out.push('<cols>');
      widths.forEach((w, i) => out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`));
      out.push('</cols>');
    }
    out.push('<sheetData>');
    rows.forEach((row, r) => {
      out.push(`<row r="${r + 1}">`);
      row.forEach((val, c) => {
        if (val === null || val === undefined || val === '') return;
        const ref = colName(c) + (r + 1);
        const style = r === 0 ? ' s="1"' : '';
        if (typeof val === 'number' && isFinite(val)) {
          out.push(`<c r="${ref}"${style}><v>${val}</v></c>`);
        } else {
          out.push(`<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(val)}</t></is></c>`);
        }
      });
      out.push('</row>');
    });
    out.push('</sheetData>');
    if (rows.length > 0 && rows[0].length > 0) {
      out.push(`<autoFilter ref="A1:${colName(rows[0].length - 1)}${Math.max(rows.length, 1)}"/>`);
    }
    out.push('</worksheet>');
    return out.join('');
  }

  const STYLES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF128C7E"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function build(sheets) {
    const used = new Set();
    const named = sheets.map((s) => ({ ...s, name: sanitizeSheetName(s.name, used) }));

    const files = [];
    files.push({
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    });
    files.push({
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    });
    files.push({
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets>' +
        (named.length
          ? '<definedNames>' +
            named
              .map((s, i) => {
                const cols = s.rows[0] ? s.rows[0].length : 1;
                return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(s.name.replace(/'/g, "''"))}'!$A$1:$${colName(cols - 1)}$${Math.max(s.rows.length, 1)}</definedName>`;
              })
              .join('') +
            '</definedNames>'
          : '') +
        '</workbook>',
    });
    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    });
    files.push({ name: 'xl/styles.xml', data: STYLES });
    named.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.widths) }));

    return zip(files);
  }

  global.WAGX_XLSX = { build, _crc32: crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
