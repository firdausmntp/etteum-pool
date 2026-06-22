' Start Etteum Pool - Silent launcher (no CMD window flash)
' Double-click ini untuk start server tanpa window CMD muncul sebentar

Dim shell, projectDir
Set shell = CreateObject("WScript.Shell")

' Get the directory where this .vbs file lives
projectDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Run Start Etteum.bat in a new visible window (window stays open for logs)
shell.Run "cmd.exe /k """ & projectDir & "\Start Etteum.bat""", 1, False

Set shell = Nothing
