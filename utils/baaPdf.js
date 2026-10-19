import PDFDocument from "pdfkit";
import { BAA_DOCUMENT_VERSION, BUSINESS_ASSOCIATE, RECITALS, BODY } from "./baaDocument.js";

export { BAA_DOCUMENT_VERSION };




function formatDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "________________";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function partyBlock(doc, title, party) {
  doc.font("Helvetica-Bold").fontSize(11).text(title);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10);
  const line = (label, value) => {
    doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
    doc.font("Helvetica").text(value || "________________");
  };
  if (party.principalAddress !== undefined) {
    line("Organization", party.organization);
    line("Principal Address", party.principalAddress);
  } else {
    line("Name/Organization", party.organization);
  }
  line("e-Signature", party.signature);
  line("Signatory name", party.signatoryName);
  line("Signatory title", party.signatoryTitle);
  doc.moveDown(0.8);
}

/**
 * Render the signed Zendoc BAA into a PDF Buffer.
 * @param {{organization?:string, signatoryName?:string, signatoryTitle?:string, signature?:string, signedAt?:Date|string, effectiveDate?:Date|string}} coveredEntity
 * @returns {Promise<Buffer>}
 */
export function generateBaaPdf(coveredEntity = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 56 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.font("Helvetica-Bold").fontSize(18).text("ZENDOC", { align: "center" });
      doc.fontSize(14).text("BUSINESS ASSOCIATE AGREEMENT", { align: "center" });
      doc.moveDown(0.8);

      doc.font("Helvetica-Bold").fontSize(10).text("Effective Date: ", { continued: true });
      doc.font("Helvetica").text(formatDate(coveredEntity.effectiveDate));
      doc.moveDown(0.8);

      partyBlock(doc, "Business Associate", BUSINESS_ASSOCIATE);
      partyBlock(doc, "Covered Entity", {
        organization: coveredEntity.organization,
        signature: coveredEntity.signature,
        signatoryName: coveredEntity.signatoryName,
        signatoryTitle: coveredEntity.signatoryTitle,
      });

      doc.font("Helvetica").fontSize(10);
      for (const para of RECITALS) {
        doc.text(para, { align: "justify" });
        doc.moveDown(0.6);
      }

      for (const block of BODY) {
        if (block.h) {
          doc.moveDown(0.4);
          doc.font("Helvetica-Bold").fontSize(11).text(block.h);
          doc.moveDown(0.2);
          doc.font("Helvetica").fontSize(10);
        } else {
          doc.text(block.p, { align: "justify" });
          doc.moveDown(0.4);
        }
      }

      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(11).text("[END OF AGREEMENT]", { align: "center" });

      doc.moveDown(1);
      doc.font("Helvetica").fontSize(8).fillColor("#666666");
      const signedAtText = coveredEntity.signedAt
        ? new Date(coveredEntity.signedAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short", timeZone: "UTC" }) + " UTC"
        : "";
      doc.text(
        `Electronically signed by ${coveredEntity.signatoryName || coveredEntity.signature || "Covered Entity"}${signedAtText ? ` on ${signedAtText}` : ""}. Document version: ${BAA_DOCUMENT_VERSION}.`,
        { align: "center" }
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
