#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowIntent {
    Show,
    Hide,
    CloseRequested,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostEvent {
    TrayShow,
    TrayHide,
    TrayQuit,
    InitialShow,
    SingleInstanceWake,
    CloseRequested,
}

pub const INTERNAL_SHOW_ARG: &str = "--vibehub-internal-show-v1";
pub const INTERNAL_QUIT_ARG: &str = "--vibehub-internal-quit-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InternalIntent {
    Show,
    Quit,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HandlerDisposition {
    Succeeded,
    Failed {
        operation: &'static str,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseRequestRecovery {
    PreventCloseAfterHide,
    TerminateHost {
        exit_code: i32,
        operation: &'static str,
        message: String,
    },
}

pub fn target_visibility(intent: WindowIntent) -> bool {
    matches!(intent, WindowIntent::Show)
}

pub fn window_intent(event: HostEvent) -> Option<WindowIntent> {
    match event {
        HostEvent::TrayShow | HostEvent::InitialShow | HostEvent::SingleInstanceWake => {
            Some(WindowIntent::Show)
        }
        HostEvent::TrayHide => Some(WindowIntent::Hide),
        HostEvent::CloseRequested => Some(WindowIntent::CloseRequested),
        HostEvent::TrayQuit => None,
    }
}

pub fn classify_handler_result(event: HostEvent, result: Result<(), String>) -> HandlerDisposition {
    match result {
        Ok(()) => HandlerDisposition::Succeeded,
        Err(message) => HandlerDisposition::Failed {
            operation: match event {
                HostEvent::TrayShow => "tray show",
                HostEvent::TrayHide => "tray hide",
                HostEvent::TrayQuit => "tray quit",
                HostEvent::InitialShow => "initial internal show",
                HostEvent::SingleInstanceWake => "single-instance wake",
                HostEvent::CloseRequested => "close-hide",
            },
            message,
        },
    }
}

pub fn internal_intent_from_args(args: &[String]) -> Option<InternalIntent> {
    match args {
        [_, argument] if argument == INTERNAL_SHOW_ARG => Some(InternalIntent::Show),
        [_, argument] if argument == INTERNAL_QUIT_ARG => Some(InternalIntent::Quit),
        _ => None,
    }
}

pub fn close_request_recovery(result: Result<(), String>) -> CloseRequestRecovery {
    match classify_handler_result(HostEvent::CloseRequested, result) {
        HandlerDisposition::Succeeded => CloseRequestRecovery::PreventCloseAfterHide,
        HandlerDisposition::Failed { operation, message } => CloseRequestRecovery::TerminateHost {
            exit_code: 1,
            operation,
            message,
        },
    }
}

pub fn report_handler_failure(operation: &str, message: &str) {
    eprintln!("vibehub-visual-host: {operation} failed: {message}");
}

pub fn observe_handler_result(event: HostEvent, result: Result<(), String>) -> bool {
    match classify_handler_result(event, result) {
        HandlerDisposition::Succeeded => true,
        HandlerDisposition::Failed { operation, message } => {
            report_handler_failure(operation, &message);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_hides_instead_of_quitting() {
        assert!(!target_visibility(WindowIntent::CloseRequested));
        assert!(!target_visibility(WindowIntent::Hide));
        assert!(target_visibility(WindowIntent::Show));
    }

    #[test]
    fn every_host_event_has_an_explicit_window_intent() {
        assert_eq!(window_intent(HostEvent::TrayShow), Some(WindowIntent::Show));
        assert_eq!(
            window_intent(HostEvent::SingleInstanceWake),
            Some(WindowIntent::Show)
        );
        assert_eq!(window_intent(HostEvent::TrayHide), Some(WindowIntent::Hide));
        assert_eq!(
            window_intent(HostEvent::CloseRequested),
            Some(WindowIntent::CloseRequested)
        );
        assert_eq!(window_intent(HostEvent::TrayQuit), None);
    }

    #[test]
    fn handler_failures_preserve_event_context_and_do_not_report_success() {
        for (event, expected_operation) in [
            (HostEvent::TrayShow, "tray show"),
            (HostEvent::TrayHide, "tray hide"),
            (HostEvent::InitialShow, "initial internal show"),
            (HostEvent::SingleInstanceWake, "single-instance wake"),
            (HostEvent::CloseRequested, "close-hide"),
        ] {
            assert_eq!(
                classify_handler_result(event, Err("native failure".to_owned())),
                HandlerDisposition::Failed {
                    operation: expected_operation,
                    message: "native failure".to_owned(),
                }
            );
        }
    }

    #[test]
    fn successful_handlers_are_the_only_success_disposition() {
        assert_eq!(
            classify_handler_result(HostEvent::TrayShow, Ok(())),
            HandlerDisposition::Succeeded
        );
    }

    #[test]
    fn close_hide_success_requires_preventing_the_default_close() {
        assert_eq!(
            close_request_recovery(Ok(())),
            CloseRequestRecovery::PreventCloseAfterHide
        );
    }

    #[test]
    fn close_hide_failure_requires_a_contextual_nonzero_termination() {
        assert_eq!(
            close_request_recovery(Err("window server rejected hide".to_owned())),
            CloseRequestRecovery::TerminateHost {
                exit_code: 1,
                operation: "close-hide",
                message: "window server rejected hide".to_owned(),
            }
        );
    }

    #[test]
    fn internal_arguments_map_only_exact_complete_argv_to_intent() {
        let executable = "/Applications/VibeHub.app/Contents/MacOS/vibehub-visual-host";
        assert_eq!(
            internal_intent_from_args(&[executable.to_owned(), INTERNAL_SHOW_ARG.to_owned()]),
            Some(InternalIntent::Show)
        );
        assert_eq!(
            internal_intent_from_args(&[executable.to_owned(), INTERNAL_QUIT_ARG.to_owned()]),
            Some(InternalIntent::Quit)
        );
        for args in [
            vec![executable.to_owned()],
            vec![executable.to_owned(), "--unknown".to_owned()],
            vec![
                executable.to_owned(),
                INTERNAL_SHOW_ARG.to_owned(),
                "--extra".to_owned(),
            ],
            vec![INTERNAL_SHOW_ARG.to_owned()],
        ] {
            assert_eq!(internal_intent_from_args(&args), None);
        }
    }
}
