{
  "targets": [
    {
      "target_name": "powershell_direct_native",
      "sources": [ "addon.cpp" ],
      "defines": [ "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "_WIN32_WINNT=0x0A00" ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "WarningLevel": 4,
          "TreatWarningAsError": true,
          "AdditionalOptions": [ "/std:c++17" ]
        }
      }
    }
  ]
}
