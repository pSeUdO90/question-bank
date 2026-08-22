module.exports = {
  packagerConfig: {
    asar: true,
    executableName: "QuestionBankBuilder",
    extraResource: ["desktop/seed", "desktop/worker"],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {
        name: "question_bank_builder",
        setupExe: "QuestionBankBuilderSetup.exe",
        noMsi: true,
      },
    },
  ],
};

