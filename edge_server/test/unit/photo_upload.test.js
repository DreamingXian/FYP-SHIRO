// Unit tests: storing an uploaded patient photo.
// Files are written to a temporary folder, never to the real upload folder.
require('./no_database');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const patientService = require('../../services/patient_service');
const { HttpError } = require('../../utils/http');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(32, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(24, 3)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

const dataUri = (buffer, type = 'image/png') => `data:${type};base64,${buffer.toString('base64')}`;

function refusedWith(status) {
  return (err) => err instanceof HttpError && err.status === status;
}

describe('image type by file content', () => {
  test('PNG, JPEG and WebP are recognised by their first bytes', () => {
    assert.equal(patientService.detectImageType(PNG), 'png');
    assert.equal(patientService.detectImageType(JPEG), 'jpg');
    assert.equal(patientService.detectImageType(WEBP), 'webp');
  });

  test('everything else is not an accepted image', () => {
    for (const other of [HTML, SVG, Buffer.from('GIF89a' + 'x'.repeat(20)), Buffer.alloc(40), Buffer.from('RIFF....WAVEfmt xxxxxxxx'), Buffer.alloc(3), 'text']) {
      assert.equal(patientService.detectImageType(other), null);
    }
  });
});

describe('storing a photo', () => {
  let uploadDir;
  let outside;

  before(() => {
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'shiro-photo-'));
    uploadDir = path.join(outside, 'uploads', 'patients');
  });

  after(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  /** Every file below the temporary folder, as paths relative to it. */
  function filesWritten() {
    const found = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else found.push(path.relative(outside, full));
      }
    };
    walk(outside);
    return found;
  }

  test('a PNG is stored inside the upload folder under a name built by the server', async () => {
    const url = await patientService.savePhotoUpload(dataUri(PNG), 'P-001', uploadDir);
    assert.match(url, /^\/uploads\/patients\/P-001_\d+_[0-9a-f]{8}\.png$/);
    const stored = path.join(uploadDir, path.basename(url));
    assert.deepEqual(fs.readFileSync(stored), PNG);
  });

  test('the extension follows the content, not the type the client declares', async () => {
    const url = await patientService.savePhotoUpload(dataUri(JPEG, 'image/png'), 'P-002', uploadDir);
    assert.match(url, /\.jpg$/);
    const webp = await patientService.savePhotoUpload(dataUri(WEBP, 'image/webp'), 'P-002', uploadDir);
    assert.match(webp, /\.webp$/);
  });

  test('two uploads for the same patient never overwrite each other', async () => {
    const a = await patientService.savePhotoUpload(dataUri(PNG), 'P-003', uploadDir);
    const b = await patientService.savePhotoUpload(dataUri(PNG), 'P-003', uploadDir);
    assert.notEqual(a, b);
  });

  test('a patient ID that tries to leave the folder is refused and nothing is written', async () => {
    const before = filesWritten();
    for (const id of ['../../evil', '..\\..\\evil', '../P-001', 'P-001/../../x', '/etc/passwd', 'C:\\x', 'a.b', '', null, undefined, {}]) {
      await assert.rejects(patientService.savePhotoUpload(dataUri(PNG), id, uploadDir), refusedWith(400), String(id));
    }
    assert.deepEqual(filesWritten(), before);
  });

  test('HTML or SVG presented as an image is refused', async () => {
    const before = filesWritten();
    await assert.rejects(patientService.savePhotoUpload(dataUri(HTML, 'image/html'), 'P-004', uploadDir), refusedWith(415));
    await assert.rejects(patientService.savePhotoUpload(dataUri(HTML, 'image/png'), 'P-004', uploadDir), refusedWith(415));
    await assert.rejects(patientService.savePhotoUpload(dataUri(SVG, 'image/svg+xml'), 'P-004', uploadDir), refusedWith(415));
    assert.deepEqual(filesWritten(), before);
  });

  test('data that is not a base64 image data URI is refused', async () => {
    for (const data of ['', 'hello', dataUri(HTML, 'text/html'), 'data:image/png;base64,***', 'data:image/png;base64,', 12, null, { a: 1 }]) {
      await assert.rejects(patientService.savePhotoUpload(data, 'P-005', uploadDir), refusedWith(400), String(data).slice(0, 30));
    }
  });

  test('a photo over the size limit is refused', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(patientService.PHOTO_MAX_BYTES)]);
    await assert.rejects(patientService.savePhotoUpload(dataUri(big), 'P-006', uploadDir), refusedWith(413));
  });
});
