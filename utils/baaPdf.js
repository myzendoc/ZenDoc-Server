import PDFDocument from "pdfkit";

export const BAA_DOCUMENT_VERSION = "zendoc-baa-2026-01";

// Business Associate party is fixed (Zendoc), per the official agreement.
const BUSINESS_ASSOCIATE = {
  organization: "MyZendoc.com",
  principalAddress: "85 Great Portland Street, London, England W1W 7LT, GB",
  signature: "Bay komms",
  signatoryName: "Bay K.",
  signatoryTitle: "Advisor",
};

// Full body of the Zendoc BAA. Each entry is a heading or a paragraph.
const BODY = [
  { h: "1. DEFINITIONS" },
  { p: 'A. The terms "Business Associate", "Covered Entity", "Disclosure" (and its plural) and "Workforce" shall have the same meanings as set forth in 45 C.F.R. § 160.103.' },
  { p: 'B. "Breach" (and its plural) shall have the same meaning as is set forth in 45 C.F.R. § 164.402 Subpart D with respect to breaches of PHI occurring on or after September 23, 2009.' },
  { p: 'C. "Data Aggregation" shall have the same meaning as is set forth in 45 C.F.R. § 164.501.' },
  { p: 'D. "Designated Record Set" shall have the same meaning as is set forth in 45 C.F.R. § 164.501.' },
  { p: 'E. "Individual" shall have the same meaning as is set forth in 45 C.F.R. § 160.103.' },
  { p: 'F. "PHI" shall have the same meaning as is set forth in 45 C.F.R. § 160.103 solely as it relates to information received from Covered Entity or created or received by Business Associate for or on behalf of Covered Entity and shall include e-PHI.' },
  { p: 'G. "Required by Law" shall have the same meaning as is set forth in 45 C.F.R. § 164.103.' },
  { p: 'H. "Secretary" shall mean the Secretary of the United States Department of Health and Human Services or his designee.' },
  { p: 'I. "Security Incident" shall have the same meaning as set forth in 45 C.F.R. § 164.304.' },
  { p: 'J. "Services" shall have the same meaning as in the Service Agreement.' },
  { p: 'K. "Unsecured PHI" shall have the same meaning as is set forth in 45 C.F.R. § 164.402 solely as it relates to information received from Covered Entity; or created or received by Business Associate for or on behalf of Covered Entity.' },
  { p: "L. Any other capitalized term not defined in this BAA shall have the same meaning as defined in the Agreement." },

  { h: "2. SERVICES" },
  { p: "A. Covered Entity and Business Associate have entered into one or more Service Agreements pursuant to which Business Associate provides services to Covered Entity that may require the use or Disclosure of PHI." },
  { p: "B. During its performance of the Services, Business Associate does not require or intend to access customer data in any specific way, including but not limited to any confidential health-related information of customer's clients that constitutes PHI. Any exposure to PHI will be random, infrequent and incidental to Business Associate's provision of its Services and is not meant for the specific purpose of creating or managing PHI. Such exposure is allowable under 45 CFR 164.502(a)(1)(iii)." },

  { h: "3. OBLIGATIONS OF BUSINESS ASSOCIATE" },
  { p: "Business Associate hereby agrees to:" },
  { p: "A. process PHI only as permitted or required by this BAA, the Service Agreement or as otherwise Required by Law;" },
  { p: "B. prevent Disclosure of PHI not expressly permitted by this BAA, the Service Agreement or as Required by Law;" },
  { p: "C. implement administrative, physical and technical safeguards that reasonably and appropriately protect the confidentiality, integrity and availability of PHI in accordance with 45 C.F.R. part 164, subpart C;" },
  { p: "D. mitigate, to the extent practicable, any harmful effects of which Business Associate becomes aware that arise out of the use or Disclosure of PHI by Business Associate that is in violation of this BAA;" },
  { p: "E. notify Covered Entity of any use or Disclosure of PHI not specifically permitted in this BAA, including Breaches of Unsecured PHI as required by 45 C.F.R. § 164.410, and any Security Incident provided that this section shall hereby serve as notice, and no additional reporting shall be required, of any unsuccessful attempts at unauthorized access, use, Disclosure, modification, or destruction of Covered Entity's e-PHI or unsuccessful interference with systems operations in an information system that involves Covered Entity's e-PHI;" },
  { p: "F. ensure that any agent, including but not limited to any subcontractor or employee, to whom Business Associate provides PHI, agrees in writing to the same restrictions as apply in this BAA to Business Associate with respect to safeguarding and appropriately using PHI;" },
  { p: "G. only disclose PHI to agents as is reasonably necessary to perform the Services or to fulfill a specific function required or permitted under this BAA;" },
  { p: "H. upon ten (10) days prior notice from Covered Entity and during all regular business hours of Business Associate, make available to Covered Entity or the Secretary all internal practices, books, records, policies and procedures, relating to the use and Disclosure of PHI, necessary to allow the Secretary to determine whether Covered Entity is compliant with the Privacy Rule, the Security Rule and the HITECH Act;" },
  { p: "I. document all Disclosures of PHI and such other information related to the Disclosure of PHI as may reasonably be necessary for Covered Entity to respond to any request by an Individual for an accounting of Disclosures of PHI as permitted by 45 C.F.R. § 164.528; and" },
  { p: "J. at its option, use PHI to provide Data Aggregation services to Covered Entity, as permitted by 45 C.F.R. § 164.504(e)(2)(i)(B)." },

  { h: "4. OBLIGATIONS OF COVERED ENTITY" },
  { p: "Covered Entity hereby agrees to:" },
  { p: "A. notify Business Associate of any changes in, or revocation of, permission by an Individual to use or disclose PHI, to the extent that such change or revocation may affect Business Associate's use or Disclosure of PHI;" },
  { p: "B. notify Business Associate in writing of any limitation(s) in its notice of privacy practices, as required by 45 C.F.R. § 164.520, to the extent that such limitation(s) may affect Business Associate's use or Disclosure of the PHI;" },
  { p: "C. notify Business Associate of any restriction(s) on the use or Disclosure of PHI that Covered Entity has agreed to in accordance with 45 C.F.R. § 164.522, to the extent that such restriction(s) may affect Business Associate's use or Disclosure of PHI;" },
  { p: "D. be responsible for using appropriate safeguards to maintain and ensure the confidentiality, privacy and security of PHI transmitted to Business Associate pursuant to this BAA and the Service Agreement in accordance with the standards and requirements of the Privacy Rule until such PHI is received by Business Associate;" },
  { p: "E. be responsible for managing all of its users of the Services including their qualified access, password restrictions, inactivity timeouts, and their ability to download and otherwise process PHI;" },
  { p: "F. reimburse Business Associate for all reasonable costs related to a query, audit, or investigation triggered by this BAA that are due to Covered Entity's actions or inactions and are outside the scope of the Services normally performed; and" },
  { p: "G. not request Business Associate to use or disclose any PHI in any manner that would not be permissible under the Privacy Rule if done by Covered Entity, except as may otherwise be provided by Section 4 of this BAA." },

  { h: "5. BREACH NOTIFICATION REQUIREMENTS" },
  { p: "A. Notification. Business Associate acknowledges that HITECH Act §13402(b) and 45 C.F.R. 164.410 require Business Associate to notify Covered Entity upon Business Associate's discovery that Unsecured PHI has been, or is reasonably believed to have been, accessed, acquired, used or disclosed as a result of a Breach. Business Associate agrees to investigate any Breach that it may discover and to provide notification to Covered Entity as required by the Breach Notification Rule and this BAA." },
  { p: "B. Discovery of Breach. A Breach will be considered discovered on the first day that a member of the Workforce or an agent of Business Associate knew that a Breach occurred." },
  { p: "C. Time Period for Notification. Business Associate will notify Covered Entity of any Breach of Unsecured PHI without unreasonable delay. Time is of the essence in providing such notice as Covered Entity is obligated to provide notification to affected Individuals, and, in some cases, to notify the media and the Secretary." },
  { p: "D. Content of Notification. Any notification by Business Associate to Covered Entity pursuant to this BAA shall, if feasible, include the following elements, to the extent possible:" },
  { p: "    a. A brief description of what happened, including the date of the Breach and the date of discovery of the Breach, if known;" },
  { p: "    b. A description of the types of Unsecured PHI, including Individuals if feasible, that were involved in the Breach;" },
  { p: "    c. Steps Individuals should take to protect themselves from potential harm resulting from the Breach;" },
  { p: "    d. A brief description of what Business Associate is doing to investigate the Breach, to mitigate harm to Individuals, and to protect against any further Breaches; and" },
  { p: "    e. Contact procedures for Individuals to ask questions or learn additional information, which must include a toll-free telephone number, an email address, Web site, or postal address." },
  { p: "E. Supplemental Notice. If Business Associate continues its investigation of a Breach after providing notification to Covered Entity, and obtains additional or different information about the Breach, it shall promptly provide a supplemental updated notice to Covered Entity, including the elements listed above." },
  { p: "F. Business Associate Support. Business Associate shall make staff available and provide support to Covered Entity as reasonably requested by Covered Entity to facilitate Covered Entity efforts to comply with the requirements of 45 C.F.R. § 164.404, 45 C.F.R. § 164.406 (notification of the media) and 45 C.F.R. § 164.408 (notification of the Secretary) of a Breach of Unsecured PHI." },

  { h: "6. RIGHTS OF INDIVIDUALS" },
  { p: "Business Associate recognizes that the Privacy Rule and state law grants an Individual certain rights related to PHI. Business Associate agrees to the following provisions for the protection of those Individual rights." },
  { p: "A. Procedure. Business Associate will cooperate with Covered Entity in responding to requests by Individuals who wish to exercise their rights under the Privacy Rule. Any requests made directly to Business Associate will be referred to Covered Entity. Business Associate will follow the direction of Covered Entity regarding the appropriate response to Individual requests and will respond in a timely manner to all requests as required by the Privacy Rule." },
  { p: "B. Confidential Communications. Business Associate will provide confidential communications to Individuals consistent with the requirements of 45 C.F.R. § 164.522." },
  { p: "C. Access to Records. To the extent that Business Associate maintains PHI in a \"designated record set,\" as directed by Covered Entity and within ten (10) days of notice by Covered Entity, Business Associate will give Individuals access to their designated record set in accordance with 45 C.F.R. § 164.524. Business Associate may charge a reasonable fee for copying or preparing a summary of the designated record set." },
  { p: "D. Amendment of Record. To the extent that Business Associate maintains PHI in a designated record set, as directed by Covered Entity and within ten (10) days of notice by Covered Entity, Business Associate will make available information in the designated record set of an Individual to allow Covered Entity to make any and all changes as required by 45 C.F.R. § 164.526." },
  { p: "E. Accounting of Disclosures. Business Associate will make available the information required to provide Individuals an accounting of Disclosures in accordance with 45 C.F.R. § 164.528." },

  { h: "7. TERM AND TERMINATION" },
  { p: "A. Term. This BAA shall be effective as of the date first set forth above and shall terminate upon the earlier of 1) the termination of any and all Service Agreements by and between the Parties; 2) the termination of the business relationship between the Parties; or 3) termination for cause as set forth below." },
  { p: "B. Termination for Cause. If either Party breaches this BAA, the non-breaching Party, in its sole discretion, may:" },
  { p: "    a. provide the breaching Party written notice that the breaching Party has breached this BAA and provide the breaching Party an opportunity to cure the breach to the satisfaction of the non-breaching Party within twenty (20) days, after which time this BAA and the Service Agreement shall be automatically terminated if the breach is not cured;" },
  { p: "    b. immediately terminate this BAA and the Service Agreement if the breaching Party has breached a material term of this BAA and cure is not possible; or" },
  { p: "    c. if neither termination nor cure is feasible, the non-breaching Party shall report the violation to the Secretary." },
  { p: "C. Effect of Termination. Except as otherwise provided in this section 7(C), upon termination of this BAA for any reason, for a period of thirty (30) days Covered Entity shall have the option to download all PHI from its account in the Services and must destroy the PHI. Business Associate desires no copies of the PHI for its records. In the event that Business Associate believes that returning or destroying the PHI is not feasible, within thirty (30) days of any termination hereof Business Associate shall provide written notice to Covered Entity. If Covered Entity determines that the return or destruction of the PHI is not feasible, then Business Associate shall extend the protections of this BAA to such PHI and limit further uses and Disclosures of such PHI to those purposes that make the return or destruction infeasible, for so long as Business Associate maintains such PHI." },

  { h: "8. MISCELLANEOUS" },
  { p: "A. Regulatory References. Any reference made herein to any provision of law or regulation shall be a reference to such section as in effect and as same may be amended from time to time." },
  { p: "B. Amendment. This BAA may not be amended except in writing signed by both Parties. Both Parties agree that this BAA shall be amended to comply with any relevant state or federal laws, rules, or regulations, including without limitation the Privacy Rule, the Security Rule and the HITECH Act." },
  { p: "C. Interpretation. Any ambiguity in this BAA shall be resolved to permit the Parties to comply with the Privacy Rule, the Security Rule and the HITECH Act." },
  { p: "D. Successors and Assigns. This BAA and all rights and obligations hereunder shall be binding upon and shall inure to the benefit of the respective successors and assigns of both Parties." },
  { p: "E. Survival. The respective rights and obligations of each party set forth herein shall survive any termination of this BAA but only with respect to the PHI received prior to the effective date of such termination." },
  { p: "F. Notices. All notices which are required to be given hereunder shall be in writing and shall be deemed to have been duly given: (a) when delivered personally; (b) the next business day following the day on which the same has been delivered prepaid to a nationally recognized overnight courier service; or (c) three (3) days after sending by registered or certified mail, postage prepaid, return receipt requested, in each case to the address first set forth above." },
  { p: "G. Severability. In the event that any provision of this BAA is adjudged by any court of competent jurisdiction to be void or unenforceable, all remaining provisions hereof shall continue to be binding on the parties hereto with the same force and effect as though such void or unenforceable provision had been deleted." },
  { p: "H. Waiver. No failure or delay in exercising any right, power or remedy hereunder shall operate as a waiver thereof; nor shall any single or partial exercise of any right, power or remedy hereunder preclude any other further exercise thereof or the exercise of any other right, power or remedy." },
  { p: "I. Disclaimer of Agency. Nothing in this BAA shall be construed to create an agency relationship between Covered Entity and Business Associate." },
  { p: "J. Counterparts, Facsimile. This BAA may be signed in two or more counterparts, each of which shall be deemed an original and all of which taken together shall constitute one and the same instrument." },
  { p: "K. Governing Law. This BAA shall be governed by and construed in accordance with the laws of the State of New York." },
  { p: "L. State Law Compliance. To the extent that New York State Law is more stringent than HIPAA, any use or Disclosure of PHI by Business Associate shall be made in accordance with New York State Law." },
  { p: "M. Books, Records, and Compliance. Pursuant to the requirements of 42 C.F.R. § 420.300 et seq., both Parties agree to make available to the Secretary of Health and Human Services (\"HHS\"), the Comptroller General of the Government Accounting Office (\"GAO\") or their authorized representatives, all agreements, books, documents and records relating to the nature and extent of costs hereunder for a period of four (4) years after termination of providing the Services hereunder. Business Associate represents and warrants that it has not been sanctioned by, excluded or otherwise declared ineligible to participate in, or barred or suspended from, Medicare, Medicaid or any other federal health care program, or is convicted of an offense related to health care." },
  { p: "N. Entire Agreement. This BAA and the Service Agreement constitute the entire agreement between the Parties hereto relating to the subject matter hereof and supersede any prior or contemporaneous verbal or written agreements, communications and representations relating to the subject matter hereof." },
];

const RECITALS = [
  'THIS BUSINESS ASSOCIATE AGREEMENT (this "BAA") is made by and between the Business Associate listed above (the "Business Associate") and the Covered Entity listed above (the "Covered Entity"), each a "Party" and collectively the "Parties". This BAA is effective as of the Effective Date above (the "Effective Date").',
  'WHEREAS, the Parties desire to enter into an agreement whereby Business Associate is providing software services to Covered Entity according to the Zendoc Terms of Use (located at https://myzendoc.com/terms/ and herein referred to as the "Service Agreement"); and',
  'WHEREAS, "Electronic Protected Health Information" or "e-PHI" as defined in 45 C.F.R. § 160.103 may be created or sent by Covered Entity to Business Associate; and',
  "WHEREAS, pursuant to 45 C.F.R. § 164.502(e)(2) and 45 C.F.R. § 164.308(b)(1), the Parties desire to enter into a written agreement that contains satisfactory assurances and the terms and conditions that Business Associate will appropriately process and safeguard the e-PHI; and",
  'WHEREAS, the Parties are required to comply with Title II of the Health Insurance Portability and Accountability Act of 1996, Pub. L. No. 104-91 ("HIPAA"), Part I of Title XIII of the American Recovery and Reinvestment Act of 2009, Pub. L. No. 111-5 ("HITECH Act") and implementing regulations enacted by the Department of Health and Human Services at 45 C.F.R. Parts 160-164 that may be amended from time to time. This includes 45 C.F.R. Part 164 Subpart C - Security Standards for the Protection of Electronic PHI (the "Security Rule"), Subpart D - Notification in the Case of Breach of Unsecured PHI (the "Breach Notification Rule"), and Subpart E - Privacy of Individually Identifiable Health Information (the "Privacy Rule").',
  "NOW, THEREFORE, upon the mutual covenants and promises contained herein, the Parties hereby agree as follows:",
];

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
