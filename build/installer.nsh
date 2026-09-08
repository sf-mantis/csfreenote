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

  ${if} $R8 == "keep"
    ; Move what belongs to the user out of the way, wipe, put it back.
    CreateDirectory "$PLUGINSDIR\keep"
    Rename "$INSTDIR\BookData" "$PLUGINSDIR\keep\BookData"
    Rename "$INSTDIR\csTemplate" "$PLUGINSDIR\keep\csTemplate"
    Rename "$INSTDIR\csFreeNote.json" "$PLUGINSDIR\keep\csFreeNote.json"
  ${endIf}

  RMDir /r $INSTDIR

  ${if} $R8 == "keep"
    CreateDirectory "$INSTDIR"
    Rename "$PLUGINSDIR\keep\BookData" "$INSTDIR\BookData"
    Rename "$PLUGINSDIR\keep\csTemplate" "$INSTDIR\csTemplate"
    Rename "$PLUGINSDIR\keep\csFreeNote.json" "$INSTDIR\csFreeNote.json"
    ; If there was nothing to keep, do not leave an empty folder behind.
    RMDir "$INSTDIR"
  ${endIf}
!macroend
