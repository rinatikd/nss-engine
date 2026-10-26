#define wmain historical_v06_main
#include "../windows-runner-v06/runner.cpp"
#undef wmain
#include <regex>
// v07 synthetic-only broker. No production adapter or arbitrary executable input.
std::string receive(HANDLE h,ULONGLONG until){
 unsigned char header[4];DWORD have=0,n=0,available=0;std::string body;unsigned size=0;
 while(GetTickCount64()<until){
  if(!PeekNamedPipe(h,nullptr,0,nullptr,&available,nullptr))throw std::string("IPC_CLOSED");
  if(!available){Sleep(2);continue;}
  if(have<4){check(ReadFile(h,header+have,1,&n,nullptr)&&n==1,"header");if(++have==4){size=(header[0]<<24)|(header[1]<<16)|(header[2]<<8)|header[3];if(!size||size>4096)throw std::string("FRAME_LIMIT");}}
  else {char c;check(ReadFile(h,&c,1,&n,nullptr)&&n==1,"body");body+=c;if(body.size()==size)return body;}
 }throw std::string("IPC_TIMEOUT");
}
void sendFrame(HANDLE h,const std::string& s){DWORD n;unsigned z=(unsigned)s.size();unsigned char b[4]={(unsigned char)(z>>24),(unsigned char)(z>>16),(unsigned char)(z>>8),(unsigned char)z};check(WriteFile(h,b,4,&n,nullptr)&&n==4,"write header");check(WriteFile(h,s.data(),z,&n,nullptr)&&n==z,"write body");}
int wmain(int argc,wchar_t** argv){try{
 if(argc==3&&std::wstring(argv[1])==L"--cleanup-crash"){std::wstring suffix=argv[2];if(!std::regex_match(suffix,std::wregex(L"[0-9]{1,10}-[0-9]{1,20}")))throw std::string("cleanup suffix");DWORD pid=std::stoul(suffix.substr(0,suffix.find(L'-')));Handle alive{OpenProcess(SYNCHRONIZE,FALSE,pid)};if(alive.h&&WaitForSingleObject(alive.h,0)!=WAIT_OBJECT_0)throw std::string("cleanup live broker denied");wchar_t self[32768];GetModuleFileNameW(nullptr,self,32768);auto root=fs::path(self).parent_path()/(L"fixture-"+suffix);hrcheck(DeleteAppContainerProfile((L"ChromeBridgeSyntheticV07."+suffix).c_str()),"crash profile cleanup");fs::remove(root/L"worker.exe");fs::remove(root);return 0;}
 std::cout.rdbuf(std::cerr.rdbuf()); if(argc!=1)throw std::string("NO_ARGUMENTS");
 auto request=receive(GetStdHandle(STD_INPUT_HANDLE),GetTickCount64()+5000);
 std::smatch m;std::regex schema("^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\|(echo|hold|crash|flood)\\|([0-9]{1,4})\\|([0-9a-f]{0,2048})$");
 if(!std::regex_match(request,m,schema)||m[4].length()%2)throw std::string("INVALID_REQUEST");
 std::string id=m[1],op=m[2],hex=m[4];unsigned timeout=std::stoul(m[3]);if(timeout<10||timeout>5000)throw std::string("INVALID_TIMEOUT");
 wchar_t self[32768];check(GetModuleFileNameW(nullptr,self,32768)>0,"self");
 std::wstring suffix=std::to_wstring(GetCurrentProcessId())+L"-"+std::to_wstring(GetTickCount64());fs::path root=fs::path(self).parent_path()/(L"fixture-"+suffix);check(fs::create_directory(root),"fresh fixture");
 struct Cleanup{fs::path p;~Cleanup(){std::error_code e;fs::remove_all(p,e);}} cleanup{root};
 fs::path exe=root/L"worker.exe";fs::copy_file(fs::path(self).parent_path()/L"worker.exe",exe);
 Profile profile;profile.name=L"ChromeBridgeSyntheticV07."+suffix;std::wcerr<<L"fixture_suffix="<<suffix<<L"\n";hrcheck(CreateAppContainerProfile(profile.name.c_str(),L"Synthetic IPC",L"Zero capability test",nullptr,0,&profile.sid),"profile");grant(root,profile.sid,FILE_GENERIC_READ|FILE_GENERIC_EXECUTE);
 Handle hostToken;check(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&hostToken.h),"host token");DWORD size=0;GetTokenInformation(hostToken.h,TokenUser,nullptr,0,&size);std::vector<char> user(size);check(GetTokenInformation(hostToken.h,TokenUser,user.data(),size,&size),"host SID");LPWSTR sid=nullptr;check(ConvertSidToStringSidW(((TOKEN_USER*)user.data())->User.Sid,&sid),"SID");
 std::wstring sddl=L"D:P(A;;GA;;;SY)(A;;GA;;;"+std::wstring(sid)+L")";LocalFree(sid);PSECURITY_DESCRIPTOR sd=nullptr;check(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),1,&sd,nullptr),"pipe SD");
 SECURITY_ATTRIBUTES sa{sizeof(sa),sd,TRUE};Handle input,write,read,output;check(CreatePipe(&input.h,&write.h,&sa,4096),"input pipe");check(CreatePipe(&read.h,&output.h,&sa,4096),"output pipe");LocalFree(sd);check(SetHandleInformation(write.h,HANDLE_FLAG_INHERIT,0),"private write");check(SetHandleInformation(read.h,HANDLE_FLAG_INHERIT,0),"private read");
 Handle job;job.h=CreateJobObjectW(nullptr,nullptr);check(job.h!=nullptr,"job");JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS|JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_TIME;limits.BasicLimitInformation.ActiveProcessLimit=1;limits.ProcessMemoryLimit=128*1024*1024;limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart=10000000;check(SetInformationJobObject(job.h,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"limits");
 SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,4,0,&bytes);std::vector<char> storage(bytes);auto attrs=(LPPROC_THREAD_ATTRIBUTE_LIST)storage.data();check(InitializeProcThreadAttributeList(attrs,4,0,&bytes),"attrs");SECURITY_CAPABILITIES caps{};caps.AppContainerSid=profile.sid;DWORD lpac=PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT,child=PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;HANDLE handles[]={input.h,output.h};
 check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,&caps,sizeof(caps),nullptr,nullptr),"caps");check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,&lpac,sizeof(lpac),nullptr,nullptr),"LPAC");check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,&child,sizeof(child),nullptr,nullptr),"children");check(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr),"handle list");
 STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);si.lpAttributeList=attrs;si.StartupInfo.dwFlags=STARTF_USESTDHANDLES;si.StartupInfo.hStdInput=input.h;si.StartupInfo.hStdOutput=output.h;si.StartupInfo.hStdError=output.h;PROCESS_INFORMATION pi{};std::wstring cmd=L"\""+exe.wstring()+L"\"";std::wstring env;for(auto key:{L"SystemRoot",L"LOCALAPPDATA"}){wchar_t value[32768];check(GetEnvironmentVariableW(key,value,32768)>0,"environment prerequisite");env+=std::wstring(key)+L"="+value;env.push_back(0);}env.push_back(0);
 BOOL ok=CreateProcessW(exe.c_str(),cmd.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,env.data(),root.c_str(),&si.StartupInfo,&pi);DeleteProcThreadAttributeList(attrs);check(ok,"launch");Handle process{pi.hProcess},thread{pi.hThread};if(!AssignProcessToJobObject(job.h,process.h)){TerminateProcess(process.h,99);throw std::string("assign");}
 Handle token;check(OpenProcessToken(process.h,TOKEN_QUERY|TOKEN_DUPLICATE,&token.h),"token");DWORD ac=0;check(GetTokenInformation(token.h,TokenIsAppContainer,&ac,4,&size)&&ac==1,"AppContainer");GetTokenInformation(token.h,TokenCapabilities,nullptr,0,&size);std::vector<char> groups(size);check(GetTokenInformation(token.h,TokenCapabilities,groups.data(),size,&size)&&((TOKEN_GROUPS*)groups.data())->GroupCount==0,"zero capabilities");GetTokenInformation(token.h,TokenAppContainerSid,nullptr,0,&size);std::vector<char> app(size);check(GetTokenInformation(token.h,TokenAppContainerSid,app.data(),size,&size)&&EqualSid(((TOKEN_APPCONTAINER_INFORMATION*)app.data())->TokenAppContainer,profile.sid),"package SID");verifyLpacSemantics(token.h,true);
 wchar_t image[32768];DWORD chars=32768;check(QueryFullProcessImageNameW(process.h,0,image,&chars)&&fs::path(image)==exe,"image identity");
 std::cerr<<"verified_pid="<<pi.dwProcessId<<" appcontainer=1 capabilities=0 lpac_access_denied=1 image_match=1 memory_limit=134217728 active_limit=1 cpu_100ns=10000000\n";check(ResumeThread(thread.h)!=(DWORD)-1,"resume");CloseHandle(input.h);input.h=nullptr;CloseHandle(output.h);output.h=nullptr;
 sendFrame(write.h,op+"|"+hex);ULONGLONG until=GetTickCount64()+timeout;std::string status="failed",response;DWORD available=0;
 while(GetTickCount64()<until){
  if(!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE),nullptr,0,nullptr,&available,nullptr))throw std::string("BROKER_DISCONNECTED");if(available){auto cancel=receive(GetStdHandle(STD_INPUT_HANDLE),until);if(cancel!="cancel|"+id)throw std::string("INVALID_CANCEL");status="cancelled";break;}
  if(PeekNamedPipe(read.h,nullptr,0,nullptr,&available,nullptr)&&available){response=receive(read.h,until);if(response!="echo|"+hex)throw std::string("INVALID_RESPONSE");status="succeeded";break;}
  if(WaitForSingleObject(process.h,0)==WAIT_OBJECT_0)break;Sleep(2);
 }
 if(GetTickCount64()>=until&&status=="failed")status="timed_out";
 check(TerminateJobObject(job.h,90),"terminate");check(WaitForSingleObject(process.h,2000)==WAIT_OBJECT_0,"death");JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};for(int i=0;i<200;i++){check(QueryInformationJobObject(job.h,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr),"accounting");if(!accounting.ActiveProcesses)break;Sleep(5);}check(accounting.ActiveProcesses==0,"empty job");
 sendFrame(GetStdHandle(STD_OUTPUT_HANDLE),"{\"v\":1,\"id\":\""+id+"\",\"status\":\""+status+"\",\"hex\":\""+(status=="succeeded"?hex:"")+"\",\"isolated\":true,\"empty\":true}");return 0;
 }catch(const std::string& e){std::cerr<<e<<"\n";return 1;}catch(const std::exception&){return 1;}}


