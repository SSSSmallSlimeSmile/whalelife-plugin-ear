@echo off
rem Launch the global F9 hold-to-talk helper.
rem Set WHALELIFE_F9_PYTHON to a pythonw.exe path; otherwise use pythonw from PATH.
set "PY=%WHALELIFE_F9_PYTHON%"
if "%PY%"=="" set "PY=pythonw"
start "" "%PY%" "%~dp0hold_to_talk.py"
