import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  input,
} from '@angular/core';

export interface UserVm {
  id: number;
  fullName: string;
}

@Component({
  selector: 'app-user-card',
  standalone: true,
  templateUrl: './user-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserCardComponent {
  // Signal input: developer preview from 17.1, absent on 17.0.
  user = input.required<UserVm>();

  @Input() badge = '';

  @Output() selected = new EventEmitter<number>();

  greeting = 'Hello';

  onSelect(id: number): void {
    this.selected.emit(id);
  }
}
