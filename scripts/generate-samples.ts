/**
 * Génère les 3 documents de test dans ./samples puis les copie dans data/input :
 *   - sample-fashion.pdf     article mode luxe FR, 2 pages, 1 image embarquée
 *   - sample-report.docx     rapport interne : paragraphes + tableau produits + image
 *   - sample-screenshot.png  capture façon post Instagram (pour l'OCR)
 *
 * Usage : npm run build && npm run samples
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { config, PROJECT_ROOT, rel } from '../src/config/env.js';

const SAMPLES_DIR = path.join(PROJECT_ROOT, 'samples');

/** Petite illustration (motif matelassé) générée en SVG → PNG. */
async function quiltedPng(w: number, h: number, color = '#e9d9cf'): Promise<Buffer> {
  const step = 40;
  let lines = '';
  for (let i = -h; i < w + h; i += step) {
    lines += `<line x1="${i}" y1="0" x2="${i + h}" y2="${h}" stroke="#b89b8a" stroke-width="2"/>`;
    lines += `<line x1="${i + h}" y1="0" x2="${i}" y2="${h}" stroke="#b89b8a" stroke-width="2"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${color}"/>${lines}
    <circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 6}" fill="#c9a96e" stroke="#8a6d3b" stroke-width="4"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/* ------------------------------------------------------------------ PDF -- */

const PDF_PAGES: { title?: string; paragraphs: string[] }[] = [
  {
    title: 'Le tweed, éternel retour sur les podiums parisiens',
    paragraphs: [
      'MODE & STYLE — Magazine papier, numéro 172, édition d\'automne. Rubrique défilés.',
      'Sous la verrière du Grand Palais, à Paris, la maison a présenté sa collection Automne-Hiver 2026 devant un parterre de rédactrices venues de New York, de Londres et de Tokyo. Le défilé, ouvert par une robe en tweed bouclé rose poudré, a confirmé la place centrale de la haute couture dans la stratégie de la marque.',
      'Les silhouettes alternaient tailleurs à épaules adoucies, chemises en soie lavallière et manteaux longs doublés de dentelle. Aux pieds, des escarpins bicolores et des ballerines matelassées ; à la main, l\'incontournable sac 2.55 en cuir d\'agneau, décliné cette saison en bordeaux et en crème.',
      'Le premier rang réunissait actrices et ambassadrices, dont plusieurs venues spécialement de Los Angeles pour l\'événement.',
    ],
  },
  {
    title: 'Les accessoires, nouveau terrain d\'expression',
    paragraphs: [
      'Au-delà du vêtement, les accessoires ont volé la vedette : lunettes de soleil à monture épaisse, bijoux fantaisie en perles et sautoirs dorés, ceintures chaînes.',
      'Côté maroquinerie, le sac Grand Shopping revient dans une version XXL en crocodile vermillon, tandis que le Sac 19 se pare de tweed multicolore. Les acheteurs européens et américains ont déjà passé commande, selon nos informations.',
      'La collection sera disponible en boutique à partir de septembre, avenue Montaigne et à Miami. Retrouvez notre dossier complet dans le prochain numéro, en kiosque le 15 du mois.',
    ],
  },
];

/** Découpe un texte en lignes tenant dans `maxWidth` (police Helvetica). */
function wrap(text: string, font: { widthOfTextAtSize: (t: string, s: number) => number }, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Le tweed, éternel retour — sample');
  pdf.setAuthor('Rédaction Mode & Style (fictif)');
  pdf.setProducer('doc-scanner-agent sample generator');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const img = await pdf.embedPng(await quiltedPng(480, 220));

  PDF_PAGES.forEach((p, idx) => {
    const page = pdf.addPage([595, 842]); // A4
    let y = 790;
    page.drawText(`MODE & STYLE · N° 172 · page ${118 + idx}`, { x: 50, y: 812, size: 8, font, color: rgb(0.45, 0.45, 0.45) });
    if (p.title) {
      for (const l of wrap(p.title, bold, 20, 495)) {
        page.drawText(l, { x: 50, y, size: 20, font: bold });
        y -= 26;
      }
      y -= 8;
    }
    if (idx === 0) {
      page.drawImage(img, { x: 50, y: y - 220, width: 480, height: 220 });
      y -= 240;
    }
    for (const para of p.paragraphs) {
      for (const l of wrap(para, font, 11, 495)) {
        page.drawText(l, { x: 50, y, size: 11, font });
        y -= 15;
      }
      y -= 10;
    }
  });
  return Buffer.from(await pdf.save());
}

/* ----------------------------------------------------------------- DOCX -- */

async function makeDocx(): Promise<Buffer> {
  const cell = (text: string, boldText = false) =>
    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: boldText })] })] });
  const rows: [string, string, string, string][] = [
    ['Produit', 'Marché', 'Retombées', 'Tonalité'],
    ['Chanel N°5', 'APAC (Tokyo, Shanghai)', '42 articles', 'Très positive'],
    ['Montre J12', 'EMEA (Genève, Dubaï)', '18 articles', 'Positive'],
    ['Sac Grand Shopping', 'AMER (New York, Los Angeles)', '27 articles', 'Positive'],
    ['Lunettes de soleil', 'EMEA (Milan, Cannes)', '11 articles', 'Neutre'],
    ['Coco Mademoiselle', 'Global', '35 articles', 'Positive'],
  ];

  const doc = new Document({
    creator: 'Service Relations Presse (fictif)',
    title: 'Rapport de retombées presse — T3 2026',
    sections: [
      {
        children: [
          new Paragraph({ text: 'Rapport de retombées presse — T3 2026', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: 'Document interne — diffusion restreinte', italics: true })] }),
          new Paragraph({ text: 'Synthèse', heading: HeadingLevel.HEADING_2 }),
          new Paragraph(
            'Ce trimestre, la couverture médiatique a été portée par le parfum et l\'horlogerie. Le lancement mondial de la nouvelle campagne Chanel N°5 a généré une visibilité exceptionnelle en Asie, tandis que la montre J12 a dominé la presse spécialisée européenne.',
          ),
          new Paragraph(
            'En maroquinerie, le Sac Grand Shopping reste le produit le plus cité aux États-Unis, notamment dans les magazines en ligne et sur Instagram, où les publications des ambassadrices ont cumulé plus de 3 millions de mentions j\'aime.',
          ),
          new Paragraph({ text: 'Détail par produit', heading: HeadingLevel.HEADING_2 }),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: rows.map((r, i) => new TableRow({ children: r.map((c) => cell(c, i === 0)) })),
          }),
          new Paragraph({ text: 'Visuel de campagne', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new ImageRun({ type: 'png', data: await quiltedPng(400, 200, '#f1e7df'), transformation: { width: 400, height: 200 } })],
          }),
          new Paragraph({ text: 'Recommandations', heading: HeadingLevel.HEADING_2 }),
          new Paragraph({ text: 'Renforcer la présence du parfum Coco Mademoiselle sur les blogs beauté.', bullet: { level: 0 } }),
          new Paragraph({ text: 'Préparer le dossier de presse joaillerie pour l\'événement de décembre à Paris.', bullet: { level: 0 } }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ PNG -- */

async function makeScreenshot(): Promise<Buffer> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = (x: number, y: number, s: string, size = 26, weight = 400, fill = '#111') =>
    `<text x="${x}" y="${y}" font-family="Helvetica, Arial, DejaVu Sans, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(s)}</text>`;
  const caption = [
    'Le nouveau parfum Chanel N°5 dévoilé ce soir à Paris',
    'lors d\'une soirée de lancement exclusive.',
    'Une fragrance mythique, réinventée pour 2026.',
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1300">
    <rect width="100%" height="100%" fill="#ffffff"/>
    ${text(40, 70, 'Instagram', 44, 700)}
    <line x1="0" y1="105" x2="900" y2="105" stroke="#dbdbdb" stroke-width="2"/>
    <circle cx="75" cy="160" r="32" fill="#e9d9cf" stroke="#c9a96e" stroke-width="4"/>
    ${text(125, 155, 'chanel.beaute.officiel', 28, 700)}
    ${text(125, 190, 'Paris, France', 24, 400, '#555')}
    <rect x="0" y="220" width="900" height="700" fill="#f3ece6"/>
    <rect x="360" y="380" width="180" height="300" rx="10" fill="#fdfaf5" stroke="#c9a96e" stroke-width="6"/>
    <rect x="410" y="330" width="80" height="50" fill="#c9a96e"/>
    ${text(395, 560, 'N°5', 54, 700)}
    ${text(40, 980, '12 458 J\'aime', 30, 700)}
    ${text(40, 1030, 'chanel.beaute.officiel', 28, 700)}
    ${caption.map((l, i) => text(40, 1075 + i * 40, l, 28)).join('\n')}
    ${text(40, 1210, '#chanel #parfum #N5 #beaute #paris', 28, 400, '#00376b')}
    ${text(40, 1260, 'Voir les 324 commentaires', 24, 400, '#8e8e8e')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/* ---------------------------------------------------------------- main -- */

async function main() {
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.mkdirSync(config.inputDir, { recursive: true });
  const files: [string, Buffer][] = [
    ['sample-fashion.pdf', await makePdf()],
    ['sample-report.docx', await makeDocx()],
    ['sample-screenshot.png', await makeScreenshot()],
  ];
  for (const [name, buf] of files) {
    fs.writeFileSync(path.join(SAMPLES_DIR, name), buf);
    fs.copyFileSync(path.join(SAMPLES_DIR, name), path.join(config.inputDir, name));
    console.log(`✨ ${name} (${(buf.length / 1024).toFixed(0)} Ko) → ${rel(SAMPLES_DIR)} + ${rel(config.inputDir)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
