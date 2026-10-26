#include <windows.h>
static char b[4096];
void entry(void){DWORD n,i=0,size;unsigned char h[4];HANDLE in=GetStdHandle(STD_INPUT_HANDLE),out=GetStdHandle(STD_OUTPUT_HANDLE);
while(i<4){if(!ReadFile(in,h+i,1,&n,0)||n!=1)ExitProcess(8);i++;}size=(h[0]<<24)|(h[1]<<16)|(h[2]<<8)|h[3];if(!size||size>4096)ExitProcess(8);
i=0;while(i<size){if(!ReadFile(in,b+i,1,&n,0)||n!=1)ExitProcess(8);i++;}
if(size==5&&b[0]=='h'&&b[1]=='o'&&b[2]=='l'&&b[3]=='d'&&b[4]=='|')Sleep(INFINITE);if(size==6&&b[0]=='c'&&b[1]=='r'&&b[2]=='a'&&b[3]=='s'&&b[4]=='h'&&b[5]=='|')ExitProcess(7);if(size==6&&b[0]=='f'&&b[1]=='l'&&b[2]=='o'&&b[3]=='o'&&b[4]=='d'&&b[5]=='|'){h[0]=0;h[1]=0;h[2]=32;h[3]=0;WriteFile(out,h,4,&n,0);ExitProcess(0);}
if(size<5||b[0]!='e'||b[1]!='c'||b[2]!='h'||b[3]!='o'||b[4]!='|')ExitProcess(8);
if(size>2053||(size-5)%2)ExitProcess(8);for(i=5;i<size;i++)if(!((b[i]>='0'&&b[i]<='9')||(b[i]>='a'&&b[i]<='f')))ExitProcess(8);WriteFile(out,h,4,&n,0);WriteFile(out,b,size,&n,0);ExitProcess(0);}

