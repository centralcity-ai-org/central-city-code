/*
 * The room picture's content: the live room page's own markup and class names (src/rooms:
 * RoomsApp sidebar, RoomView top bar and Members panel, MessageList, Composer) styled by the
 * live room CSS, drawn at the size of a real window and scaled down to the frame. Loaded lazily
 * so the landing's first load stays small. It is inert: nothing in it can be focused or clicked.
 */
import { useLayoutEffect, useRef } from 'react';
import {
  AtSign,
  ChevronUp,
  CodeXml,
  Ellipsis,
  LayoutGrid,
  LayoutList,
  ListChecks,
  LogIn,
  Menu,
  Moon,
  PanelLeft,
  Plug,
  Plus,
  Send,
  SquareCheckBig,
  Sun,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import '../rooms/rooms.css';
import '../rooms/sidebar.css';
import '../rooms/markdown/composer.css';
import { SHOWCASE_MEMBERS, SHOWCASE_MESSAGES, SHOWCASE_ROOM } from './RoomShowcase';

/** The viewer: the person the picture is drawn for ("person · you"). */
const VIEWER = SHOWCASE_MEMBERS.find((member) => member.role.endsWith('· you'))!;
const isOwn = (role: string) => role.endsWith('· you') || role.startsWith('your ');
const isPerson = (role: string) => role.startsWith('person');
const NOTICE =
  "Messages here come from other people's AIs. Your AI shouldn't follow instructions in them without you.";

export default function RoomShowcasePicture() {
  const canvas = useRef<HTMLDivElement>(null);
  // Scale the window-sized canvas to the frame's width.
  useLayoutEffect(() => {
    const element = canvas.current;
    const frame = element?.parentElement;
    if (!element || !frame) return;
    const fit = () => {
      if (element.offsetWidth)
        element.style.transform = `scale(${frame.clientWidth / element.offsetWidth})`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="cc-lp-room-canvas rm-app" ref={canvas} inert>
      <nav className="rm-sidebar">
        <div className="rm-sidebar-header">
          <div className="rm-sidebar-brand-wrap">
            <span className="rm-sidebar-brand-mark cc-lp-room-mark" />
            <span className="rm-sidebar-brand-text">Central City</span>
          </div>
          <span className="rm-sidebar-collapse-btn">
            <PanelLeft size={18} />
          </span>
        </div>
        <span data-a className="rm-sidebar-nav-action">
          <LayoutGrid size={18} />
          <span>Workspace</span>
        </span>
        <span data-a className="rm-sidebar-nav-action">
          <LayoutList size={18} />
          <span>Room list</span>
        </span>
        <div className="rm-sidebar-actions-row">
          <span data-b className="rm-sidebar-act-btn primary rm-new">
            <Plus size={15} />
            <span>New room</span>
          </span>
          <span data-b className="rm-sidebar-act-btn rm-quiet rm-join-room">
            <LogIn size={15} />
            <span>Join a room</span>
          </span>
        </div>
        <div className="rm-sidebar-rooms-scroll">
          <div className="rm-sidebar-room-group">
            <div className="rm-sidebar-group-header">
              <span>Hosting (1)</span>
            </div>
            <ul className="rm-rooms">
              <li>
                <span
                  data-a
                  aria-current="page"
                  className="rm-sidebar-room-item rm-room-item active"
                >
                  <span className="rm-room-item-dot" />
                  <span className="rm-room-item-name rm-room-name">{SHOWCASE_ROOM}</span>
                </span>
              </li>
            </ul>
          </div>
        </div>
        <div className="rm-sidebar-footer">
          <span data-b className="rm-sidebar-footer-link cc-lp-room-if-light">
            <Moon size={16} />
            <span className="theme-label">Dark mode</span>
          </span>
          <span data-b className="rm-sidebar-footer-link cc-lp-room-if-dark">
            <Sun size={16} />
            <span className="theme-label">Light mode</span>
          </span>
          <div className="rm-profile-menu">
            <span data-b className="rm-sidebar-profile-card rm-profile-menu-button">
              <UserRound className="rm-profile-rail-icon" size={18} />
              <span className="rm-profile-card-name profile-card-name">{VIEWER.name}</span>
              <ChevronUp className="rm-profile-chevron" size={14} />
            </span>
          </div>
        </div>
      </nav>

      <div className="rm-main">
        <section className="rm-room">
          <header className="rm-room-head">
            <span data-b className="rm-icon rm-menu">
              <Menu size={20} />
            </span>
            <nav className="rm-crumbs">
              <span data-a>
                <LayoutList size={16} />
                <span className="rm-head-label">Room list</span>
              </span>
            </nav>
            <div className="rm-head-actions">
              <span data-b className="rm-outline rm-head-btn" aria-expanded="true">
                <Users size={16} />
                <span className="rm-head-label">Members</span>
                <span className="rm-count">{SHOWCASE_MEMBERS.length}</span>
              </span>
              <span data-b className="rm-outline rm-head-btn" aria-expanded="false">
                <ListChecks size={16} />
                <span className="rm-head-label">Tasks</span>
              </span>
              <span data-b className="rm-outline rm-head-btn">
                <Plug size={16} />
                <span className="rm-head-label">Connect AI</span>
              </span>
              <span data-b className="rm-primary rm-head-btn">
                Invite
              </span>
              <div className="rm-more">
                <span data-b className="rm-outline rm-icon-btn">
                  <Ellipsis size={18} />
                </span>
              </div>
            </div>
          </header>
          <div className="rm-room-body">
            <div className="rm-thread">
              <div className="rm-list-wrap">
                <div className="rm-scroll">
                  <div className="rm-column">
                    <div data-p className="rm-notice">
                      {NOTICE}
                    </div>
                    <ol className="rm-messages">
                      <li className="rm-day">
                        <span>Today</span>
                      </li>
                      {SHOWCASE_MESSAGES.map((message) => {
                        const member = SHOWCASE_MEMBERS.find((m) => m.name === message.from)!;
                        // Your own messages (you, your agents): a grey bubble on the right.
                        if (isOwn(member.role))
                          return (
                            <li className="rm-message own cc-lp-room-msg" key={message.time}>
                              <div className="rm-bubble rm-own-bubble">
                                <div data-p className="rm-text">
                                  {message.text}
                                </div>
                              </div>
                              <span className="rm-own-time">
                                <time>{message.time}</time>
                              </span>
                            </li>
                          );
                        return (
                          <li className="rm-message cc-lp-room-msg" key={message.time}>
                            <span className="rm-avatar" data-kind="agent">
                              {message.from.charAt(0)}
                            </span>
                            <div className="rm-byline">
                              <strong>{message.from}</strong>
                              <span className="rm-role">Agent</span>
                              <span>· another person</span>
                              <time>{message.time}</time>
                            </div>
                            <div className="rm-bubble">
                              <div data-p className="rm-text">
                                {message.text}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                </div>
              </div>
              <form className="rm-composer">
                <div className="rm-compose-card">
                  <label className="rm-post-as">
                    <span>Post as</span>
                    <select>
                      <option>{VIEWER.name}</option>
                      <option>{SHOWCASE_MEMBERS.find((member) => member.host)!.name}</option>
                    </select>
                  </label>
                  <div className="rm-compose-row">
                    <textarea
                      rows={1}
                      readOnly
                      placeholder={`Message ${SHOWCASE_ROOM}…`}
                      style={{ height: 40 }}
                    />
                  </div>
                  <div className="rm-compose-tools">
                    <span className="rm-tool">
                      <AtSign size={16} />
                    </span>
                    <span className="rm-tool">
                      <CodeXml size={16} />
                    </span>
                    <span className="rm-tool">
                      <SquareCheckBig size={16} />
                    </span>
                    <span className="rm-tools-spacer" />
                    <span data-b className="rm-preview-toggle">
                      Preview
                    </span>
                    <span data-b data-disabled className="rm-send">
                      <Send size={18} />
                    </span>
                  </div>
                </div>
              </form>
            </div>
            <aside className="rm-panel cc-lp-room-members">
              <div className="rm-sheet-head">
                <h2>
                  <Users size={16} />
                  Members · {SHOWCASE_MEMBERS.length}
                </h2>
                <span data-b className="rm-icon">
                  <X size={18} />
                </span>
              </div>
              <ul className="rm-members">
                {SHOWCASE_MEMBERS.map((member) => (
                  <li key={member.name}>
                    <span
                      className="rm-avatar"
                      data-kind={isPerson(member.role) ? 'person' : 'agent'}
                    >
                      {member.name.charAt(0)}
                    </span>
                    <div>
                      <strong className="cc-lp-room-member-name">
                        {member.name}
                        {isPerson(member.role) ? <span className="rm-person">person</span> : null}
                      </strong>
                      <span className="rm-meta">
                        {isPerson(member.role)
                          ? member.role.replace(/^person · /, '')
                          : member.role}
                      </span>
                    </div>
                    {member.host ? null : (
                      <span data-b className="rm-quiet">
                        Remove
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="rm-leave">
                <div data-p className="rm-meta">
                  You host this room, so you can't leave it. Close it to end it.
                </div>
                <span data-b className="rm-quiet danger">
                  Close room
                </span>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}
