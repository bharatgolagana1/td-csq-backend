const mongoose = require("mongoose");
(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== "csq_import_export_dev") {
      throw new Error("Wrong database");
    }
    const cycle = await db.collection("cycles").findOne({
      code: "CSQ-26H6"
    });
    const org = await db.collection("organisations").findOne({
      code: "BOM-MACH"
    });
    if (!cycle || !org) {
      throw new Error("Cycle or organisation not found");
    }
    console.log("\n=== CYCLE ===");
    console.log("Name:", cycle.name);
    console.log("Status:", cycle.status);
    console.log("Scored at:", cycle.scoredAt ?? "Not recorded");
    const assessments = await db.collection("assessments")
      .find({
        cycleId: cycle._id,
        acoId: org._id,
        kind: "CUSTOMER"
      })
      .project({
        status: 1,
        surveyType: 1,
        answerMode: 1,
        submittedAt: 1,
        answers: 1
      })
      .toArray();
    console.log("\n=== CUSTOMER ASSESSMENTS ===");
    console.log("Total:", assessments.length);
    assessments.forEach((a, i) => {
      const answers = a.answers ?? [];
      const importAnswers = answers.filter(
        x => x.direction === "IMPORT"
      );
      const exportAnswers = answers.filter(
        x => x.direction === "EXPORT"
      );
      console.log({
        assessment: i + 1,
        status: a.status,
        surveyType: a.surveyType,
        answerMode: a.answerMode ?? "SINGLE",
        submittedAt: a.submittedAt ?? null,
        importAnswered: importAnswers.length,
        exportAnswered: exportAnswers.length,
        importRated: importAnswers.filter(
          x => !x.na && x.rating != null
        ).length,
        exportRated: exportAnswers.filter(
          x => !x.na && x.rating != null
        ).length
      });
    });
    console.log("\n=== STORED IMPORT SCORES ===");
    const scores = await db.collection("scores")
      .find({
        cycleId: cycle._id,
        acoId: org._id,
        surveyType: "DOMESTIC",
        direction: "IMPORT"
      })
      .toArray();
    console.log("Score documents:", scores.length);
    const overall = scores.find(
      s => s.level === "OVERALL"
    );
    if (overall) {
      console.log("Overall score fields:", Object.keys(overall));
      console.log("Responses:", overall.n ?? overall.customer?.n ?? null);
      console.log("Mean:", overall.mean ?? overall.customer?.mean ?? null);
      console.log("Suppressed:", overall.suppressed ?? null);
      console.log("Computed at:", overall.computedAt ?? null);
    } else {
      console.log("No OVERALL Import score found");
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch(error => {
  console.error("Check failed:", error.message);
  process.exitCode = 1;
});
