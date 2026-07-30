import { Component } from '@angular/core';
import { NamedEntity } from '@fixture/models';

@Component({
  selector: 'app-alias-card',
  standalone: true,
  template: '<span>{{ describe() }}</span>',
})
export class AliasCardComponent extends NamedEntity {}
