import { getBaaForDocument, getUserById } from "../services/userService.js";
import { generateBaaPdf } from "../utils/baaPdf.js";
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
