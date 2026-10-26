# Windows API references and contract limits

This is a source design reference. Links point to Microsoft documentation; they do not prove this prototype has been built or observed.

- [`WINTRUST_FILE_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_file_info): `pcwszFilePath` is required and `hFile` is optional. The prototype supplies both from a held handle's normalized volume path.
- [`WinVerifyTrust`](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust): only a zero return is success. The trust provider is pluggable.
- [`WTHelperGetProvSignerFromChain`](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-wthelpergetprovsignerfromchain): Microsoft documents the helper as potentially changeable/unavailable and requires dynamic linking. This code fails closed if helper symbols/state/certificates are unavailable; this remains a compatibility and review risk.
- [`CreateProcess` flags](https://learn.microsoft.com/en-us/windows/desktop/ProcThread/process-creation-flags): `CREATE_SUSPENDED` leaves the primary thread suspended until `ResumeThread`.
- [`UpdateProcThreadAttribute`](https://learn.microsoft.com/en-us/windows/desktop/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): HANDLE_LIST requires inheritable handles and `bInheritHandles=TRUE`; JOB_LIST is documented for supported Windows versions.
- [`Launch an AppContainer`](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer): documents AppContainer/LPAC attributes, including the all-application-packages opt-out policy used for LPAC.
- [`FILE_ID_INFO`](https://learn.microsoft.com/en-us/windows/desktop/api/winbase/ns-winbase-file_id_info): volume serial plus 128-bit file ID can compare whether two handles refer to the same file on one computer.
- [`Job Objects`](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [`job limits`](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information): kill-on-close, active process limits, and breakaway flags.

## Important limits

1. The documented file-ID equality and held read-only handle reduce ordinary path replacement/write races, but the full CreateProcess image-section binding is not an explicit transactional API contract. This prototype checks child image path/file ID/hash while suspended and keeps the candidate handle open; independent VM testing and Windows filesystem review are still required.
2. The Wintrust helper structures/functions are documented as potentially changing. No successful compilation/runtime has validated the exact signer certificate extraction in this source.
3. `PROC_THREAD_ATTRIBUTE_JOB_LIST` documents assignment during process creation, but this package does not claim a complete documented rollback contract for caller termination during `CreateProcessW`.
4. AppContainer, LPAC, Job Object, environment, pipe handle list, ACL, credential denial, network denial, crash cleanup and child containment are unverified on a real Windows VM.
5. The synthetic worker's output is untrusted diagnostic data. Acceptance requires controller/host observations and evidence tied to the tested SHA.
