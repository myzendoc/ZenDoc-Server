import { getBaaForDocument, getUserById } from "../services/userService.js";
import { generateBaaPdf } from "../utils/baaPdf.js";
import { BAA_DOCUMENT_VERSION, BUSINESS_ASSOCIATE, RECITALS, BODY } from "../utils/baaDocument.js";
import { sendErrorResponse } from "../utils/errors.js";

export async function downloadBaaDocument(req, res) {
  try {
    const user = await getUserById(req.user?._id);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!user.baa?.signed) {
      res.status(404).json({ error: "No signed BAA on file" });
      return;
    }
    // sanitizeUser strips the signature, so read it straight from the document.
    const baa = await getBaaForDocument(req.user?._id);
    const pdfBuffer = await generateBaaPdf({
      organization: baa?.organization,
      signatoryName: baa?.signatoryName,
      signatoryTitle: baa?.signatoryTitle,
      signature: baa?.signature,
      signedAt: baa?.signedAt,
      effectiveDate: baa?.effectiveDate,
    });
    const disposition = String(req.query?.download || "") === "1" ? "attachment" : "inline";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `${disposition}; filename="Zendoc-BAA-signed.pdf"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    sendErrorResponse(res, err, { fallback: "Failed to generate BAA document", event: "baa.document_failed" });
  }
}

// Public: the consent screen renders this before signup, so it cannot require auth.
export function getBaaText(_req, res) {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.json({
    version: BAA_DOCUMENT_VERSION,
    businessAssociate: BUSINESS_ASSOCIATE,
    recitals: RECITALS,
    body: BODY,
  });
}
