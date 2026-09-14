; Uninstall without taking the user's notes with it.
;
; csFreeNote keeps BookData, csTemplate and its settings beside the executable,
; which is what makes the folder simple to move or carry. It also means the
; default uninstaller — RMDir /r $INSTDIR — deletes years of notes along with
; the program.
;
; This replaces that step. Notes are kept unless the person uninstalling says
; otherwise, and the question is never asked when it would not be a real
; question: an upgrade uninstalls the old version first, and a silent uninstall
; has nobody to answer.

!macro customRemoveFiles
  !include FileFunc.nsh
  ; $R8 = "delete" only when someone has explicitly asked for it.
  StrCpy $R8 "keep"

  ; /DELETEDATA answers the question up front, so the branch that removes
  ; notes can be exercised without a person clicking the box.
  ${GetParameters} $R7
  ${GetOptions} $R7 "/DELETEDATA" $R6
  ${ifNot} ${errors}
    StrCpy $R8 "delete"
  ${elseIfNot} ${isUpdated}
    ; Not IfSilent: a one-click uninstaller turns silent mode on itself after
    ; its own confirmation dialog, so by now it always reads as silent. What
    ; actually distinguishes an unattended run is /S on the command line.
    ${GetOptions} $R7 "/S" $R6
    ${ifNot} ${errors}
      Goto skip_prompt
    ${endIf}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "노트도 함께 삭제하시겠습니까?$\r$\n$\r$\n\
아니요를 누르면 BookData 폴더와 설정이 남습니다.$\r$\n\
$INSTDIR$\r$\n$\r$\n\
삭제한 노트는 되돌릴 수 없습니다." \
        IDYES want_delete IDNO skip_prompt
      want_delete:
        StrCpy $R8 "delete"
    skip_prompt:
  ${endIf}

  ; $R9 = "wipe" until something the user owns turns out to be still in place.
  StrCpy $R9 "wipe"

  ${if} $R8 == "keep"
    ; Move what belongs to the user out of the way, wipe, put it back.
    ;
    ; Rename is best effort. Windows refuses to move a folder while any file
    ; anywhere inside it is open — with any sharing mode, by any process — and
    ; says so only through the error flag. The wipe below did not read it, and
    ; so a real install lost a book of notes: something was reading one of the
    ; 86 note files, BookData could not be moved, RMDir /r ran regardless.
    ; csTemplate, three files that nothing happened to be reading, came back.
    ;
    ; Whoever holds it is rarely the program itself, which the installer has
    ; already closed by now — it is a virus scanner, the search indexer, a
    ; company agent walking the disk. Those handles last a moment, so try
    ; again a few times before concluding anything.
    CreateDirectory "$PLUGINSDIR\keep"
    StrCpy $R5 0
    move_aside:
      Rename "$INSTDIR\BookData" "$PLUGINSDIR\keep\BookData"
      Rename "$INSTDIR\csTemplate" "$PLUGINSDIR\keep\csTemplate"
      Rename "$INSTDIR\csFreeNote.json" "$PLUGINSDIR\keep\csFreeNote.json"
      ; Ask the disk rather than the flag. Anything still standing here did
      ; not move, and the wipe would destroy it.
      IfFileExists "$INSTDIR\BookData" retry_move 0
      IfFileExists "$INSTDIR\csTemplate" retry_move 0
      IfFileExists "$INSTDIR\csFreeNote.json" retry_move 0
      Goto moved
    retry_move:
      IntOp $R5 $R5 + 1
      IntCmp $R5 8 give_up 0 give_up
      Sleep 500
      Goto move_aside
    give_up:
      ; Put back whatever did move, and leave the folder standing. Old program
      ; files that outlive this are overwritten by the install that follows, or
      ; sit there unused; notes are not something a later step can put back.
      Rename "$PLUGINSDIR\keep\BookData" "$INSTDIR\BookData"
      Rename "$PLUGINSDIR\keep\csTemplate" "$INSTDIR\csTemplate"
      Rename "$PLUGINSDIR\keep\csFreeNote.json" "$INSTDIR\csFreeNote.json"
      StrCpy $R9 "spare"
    moved:
  ${endIf}

  ${if} $R9 == "wipe"
    RMDir /r $INSTDIR
  ${else}
    ; The program's own files, named one at a time. BookData, csTemplate and
    ; the settings are not named here and so cannot be reached from this
    ; branch even if the judgement that led to it was wrong.
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\swiftshader"
    RMDir /r "$INSTDIR\temp"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\csFreeNote.exe"
    Delete "$INSTDIR\icon.ico"
    Delete "$INSTDIR\vk_swiftshader_icd.json"
    Delete "$INSTDIR\LICENSE.electron.txt"
    Delete "$INSTDIR\LICENSES.chromium.html"
    Delete "$INSTDIR\Uninstall csFreeNote.exe"
  ${endIf}

  ${if} $R8 == "keep"
  ${andif} $R9 == "wipe"
    ; The way back is the same risk mirrored. The notes are now in a folder
    ; that this program deletes when it ends, and a scanner that follows them
    ; there is enough to refuse the move home. So: try again, and then stop
    ; trying to move and copy instead — copying only has to read, which a
    ; scanner holding a note does not prevent.
    CreateDirectory "$INSTDIR"
    StrCpy $R5 0
    put_back:
      Rename "$PLUGINSDIR\keep\BookData" "$INSTDIR\BookData"
      Rename "$PLUGINSDIR\keep\csTemplate" "$INSTDIR\csTemplate"
      Rename "$PLUGINSDIR\keep\csFreeNote.json" "$INSTDIR\csFreeNote.json"
      ; Anything still in the holding folder has not come home.
      IfFileExists "$PLUGINSDIR\keep\BookData" retry_back 0
      IfFileExists "$PLUGINSDIR\keep\csTemplate" retry_back 0
      IfFileExists "$PLUGINSDIR\keep\csFreeNote.json" retry_back 0
      Goto back_home
    retry_back:
      IntOp $R5 $R5 + 1
      IntCmp $R5 8 copy_back 0 copy_back
      Sleep 500
      Goto put_back
    copy_back:
      ; Leaves the originals behind, which costs nothing: the holding folder
      ; is thrown away in a moment either way.
      IfFileExists "$PLUGINSDIR\keep\BookData" 0 +2
        CopyFiles /SILENT "$PLUGINSDIR\keep\BookData" "$INSTDIR"
      IfFileExists "$PLUGINSDIR\keep\csTemplate" 0 +2
        CopyFiles /SILENT "$PLUGINSDIR\keep\csTemplate" "$INSTDIR"
      IfFileExists "$PLUGINSDIR\keep\csFreeNote.json" 0 +2
        CopyFiles /SILENT "$PLUGINSDIR\keep\csFreeNote.json" "$INSTDIR"
    back_home:
    ; If there was nothing to keep, do not leave an empty folder behind.
    RMDir "$INSTDIR"
  ${endIf}

  ; Chromium's own scratch, in $APPDATA\csFreeNote, which the program never
  ; chose and the uninstaller was leaving behind — tens of megabytes of cache
  ; and spellchecking dictionaries after everything else had gone.
  ;
  ; Named one by one, never RMDir /r on the folder itself. That folder is where
  ; the program falls back to when the place beside the executable cannot be
  ; written to, so for somebody who installed under Program Files it holds
  ; their notes. BookData, csTemplate and the settings are not named here, and
  ; so cannot be reached even if this is wrong.
  RMDir /r "$APPDATA\${APP_FILENAME}\Cache"
  RMDir /r "$APPDATA\${APP_FILENAME}\Code Cache"
  RMDir /r "$APPDATA\${APP_FILENAME}\GPUCache"
  RMDir /r "$APPDATA\${APP_FILENAME}\DawnGraphiteCache"
  RMDir /r "$APPDATA\${APP_FILENAME}\DawnWebGPUCache"
  RMDir /r "$APPDATA\${APP_FILENAME}\Dictionaries"
  RMDir /r "$APPDATA\${APP_FILENAME}\blob_storage"
  RMDir /r "$APPDATA\${APP_FILENAME}\Local Storage"
  RMDir /r "$APPDATA\${APP_FILENAME}\Session Storage"
  RMDir /r "$APPDATA\${APP_FILENAME}\Network"
  RMDir /r "$APPDATA\${APP_FILENAME}\SharedStorage"
  RMDir /r "$APPDATA\${APP_FILENAME}\Shared Dictionary"
  Delete "$APPDATA\${APP_FILENAME}\Local State"
  Delete "$APPDATA\${APP_FILENAME}\Preferences"
  ; Only if nothing of the user's was in there. RMDir without /r refuses a
  ; folder that still holds something.
  RMDir "$APPDATA\${APP_FILENAME}"
!macroend
