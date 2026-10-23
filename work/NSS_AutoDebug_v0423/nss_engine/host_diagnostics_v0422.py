"""Triage startup evidence without assigning an unconfirmed failure to the DLL."""
def decode_host_log(data):
    if data.startswith((b'\xff\xfe',b'\xfe\xff')):
        return data.decode('utf-16',errors='replace')
    if data and data.count(b'\0')>len(data)//5:
        return data.decode('utf-16-le',errors='replace')
    return data.decode('utf-8-sig',errors='replace')


def diagnose(data,exit_code=None,native_report_present=False):
    text=decode_host_log(data)
    if 'Cannot get temporary directory long path name' in text:
        code='HOST_TEMP_DIRECTORY_ERROR'
    elif 'Problem with setting up current profile' in text:
        code='HOST_PROFILE_SETUP_ERROR'
    elif native_report_present:
        code='NATIVE_REPORT_AVAILABLE'
    elif exit_code is not None:
        code='HOST_EXITED_BEFORE_NATIVE_REPORT'
    else:
        code='NATIVE_REPORT_NOT_YET_AVAILABLE'
    return dict(code=code,exit_code=exit_code,native_report_present=native_report_present,
                plugin_failure_confirmed=False,
                explanation='Host startup evidence does not establish a DLL defect; inspect native tests if present.',
                fallback='RUN_IN_AUTOCAD.lsp' if not native_report_present else None,
                host_log_excerpt=text[-4000:])
